import { z } from 'zod'
import type { Server } from '@modelcontextprotocol/sdk/server/index.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import {
  CreateCheckoutSchema,
  CompleteSandboxCheckoutSchema,
  CreateWalletSessionSchema,
  CreateUserWalletSchema,
  EmptySchema,
  FailSandboxCheckoutSchema,
  IntegrationGuideSchema,
  GetWalletActivitySchema,
  ListSandboxEventsSchema,
  RequestRefundSchema,
  SdkExampleSchema,
  SendSandboxWebhookTestSchema,
} from './schemas.js'

type HttpMethod = 'GET' | 'POST'

interface ToolDef {
  name: string
  description: string
  inputSchema: z.ZodType
  method: HttpMethod
  endpoint: string
  mutating: boolean
  requireIdempotency?: boolean
  amountLimitCents?: number
  resolveEndpoint?: (args: Record<string, unknown>) => string
  query?: (args: Record<string, unknown>) => Record<string, string | number | boolean | undefined>
  body?: (args: Record<string, unknown>) => Record<string, unknown>
}

interface AuditEntry {
  timestamp: string
  tool: string
  actor: string
  args_summary: string
  request_id: string | null
  success: boolean
  error: string | null
}

let apiKey = ''
let baseUrl = ''
let allowWrites = false
let allowedTools: Set<string> | null = null
let actor = 'public-mcp'

export function configure(opts: {
  apiKey: string
  baseUrl: string
  allowWrites: boolean
  allowedTools: string[] | null
  actor: string
}) {
  apiKey = opts.apiKey
  baseUrl = normalizeBaseUrl(opts.baseUrl)
  allowWrites = opts.allowWrites
  allowedTools = opts.allowedTools ? new Set(opts.allowedTools) : null
  actor = opts.actor || 'public-mcp'
}

export function normalizeBaseUrl(input: string): string {
  const raw = (input || 'https://api.soledgic.com/v1').trim().replace(/\/+$/, '')
  const deduped = raw.replace(/(?:\/v1)+$/, '/v1')
  return deduped.endsWith('/v1') ? deduped : `${deduped}/v1`
}

const RATE_WINDOW_MS = 60_000
const READ_RATE_LIMIT = 30
const WRITE_RATE_LIMIT = 10
const REQUEST_TIMEOUT_MS = 30_000
const DOCS_BASE_URL = 'https://soledgic.com/docs'

const rateBuckets = new Map<string, { count: number; windowStart: number }>()

function checkRateLimit(toolName: string, isMutating: boolean): string | null {
  const now = Date.now()
  const limit = isMutating ? WRITE_RATE_LIMIT : READ_RATE_LIMIT
  const bucket = rateBuckets.get(toolName)

  if (!bucket || now - bucket.windowStart > RATE_WINDOW_MS) {
    rateBuckets.set(toolName, { count: 1, windowStart: now })
    return null
  }

  if (bucket.count >= limit) {
    const retryAfter = Math.ceil((bucket.windowStart + RATE_WINDOW_MS - now) / 1000)
    return `Rate limited: ${toolName} exceeded ${limit} calls/minute. Retry after ${retryAfter}s.`
  }

  bucket.count += 1
  return null
}

function isLiveKey(key: string): boolean {
  return key.startsWith('slk_live_')
}

function audit(entry: AuditEntry) {
  process.stderr.write(`${JSON.stringify(entry)}\n`)
}

function summarizeArgs(args: Record<string, unknown>): string {
  const redacted = redactValue(args)
  return JSON.stringify(redacted)
}

function redactValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactValue)
  if (!value || typeof value !== 'object') return value

  const result: Record<string, unknown> = {}
  for (const [key, nested] of Object.entries(value)) {
    const lower = key.toLowerCase()
    if (
      lower.includes('secret') ||
      lower.includes('token') ||
      lower.includes('api_key') ||
      lower.includes('apikey') ||
      lower.includes('email')
    ) {
      result[key] = '[REDACTED]'
    } else {
      result[key] = redactValue(nested)
    }
  }
  return result
}

function errorResult(text: string, auditPartial?: Partial<AuditEntry>) {
  if (auditPartial) {
    audit({
      timestamp: new Date().toISOString(),
      actor,
      request_id: null,
      success: false,
      tool: '',
      args_summary: '',
      error: text,
      ...auditPartial,
    })
  }

  return {
    content: [{ type: 'text' as const, text }],
    isError: true,
  }
}

async function apiRequest(
  method: HttpMethod,
  endpoint: string,
  body?: unknown,
  queryParams?: Record<string, string | number | boolean | undefined>,
): Promise<{ data: unknown; requestId: string | null; ok: boolean }> {
  const url = new URL(`${baseUrl}/${endpoint}`)

  if (queryParams) {
    for (const [key, value] of Object.entries(queryParams)) {
      if (value !== undefined) url.searchParams.set(key, String(value))
    }
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)

  try {
    const response = await fetch(url.toString(), {
      method,
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    })

    const requestId = response.headers.get('x-request-id')
    const text = await response.text()
    const data = text ? safeJson(text) : { success: response.ok }

    if (!response.ok) {
      const error =
        typeof data === 'object' && data && 'error' in data
          ? String((data as { error: unknown }).error)
          : `HTTP ${response.status}`
      return { data: { success: false, error, status: response.status }, requestId, ok: false }
    }

    return { data, requestId, ok: true }
  } catch (error) {
    const message =
      error instanceof Error
        ? error.name === 'AbortError'
          ? `Request timed out after ${REQUEST_TIMEOUT_MS}ms`
          : error.message
        : 'Unknown error'
    return { data: { success: false, error: message }, requestId: null, ok: false }
  } finally {
    clearTimeout(timeout)
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

function pickQuery(args: Record<string, unknown>, keys: string[]) {
  const query: Record<string, string | number | boolean | undefined> = {}
  for (const key of keys) {
    const value = args[key]
    if (
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean'
    ) {
      query[key] = value
    }
  }
  return query
}

function moneyAmount(args: Record<string, unknown>): number | null {
  return typeof args.amount === 'number' ? args.amount : null
}

const TOOLS: ToolDef[] = [
  {
    name: 'get_api_status',
    description: 'Read Soledgic API health/status for the configured API key.',
    inputSchema: EmptySchema,
    method: 'POST',
    endpoint: 'health-check',
    mutating: false,
    body: () => ({ action: 'status' }),
  },
  {
    name: 'get_integration_guide',
    description: 'Get Soledgic docs links and short guidance for a public integration topic.',
    inputSchema: IntegrationGuideSchema,
    method: 'GET',
    endpoint: '',
    mutating: false,
    body: () => ({}),
  },
  {
    name: 'get_sdk_example',
    description: 'Get a concise TypeScript SDK example for a common integration flow.',
    inputSchema: SdkExampleSchema,
    method: 'GET',
    endpoint: '',
    mutating: false,
    body: () => ({}),
  },
  {
    name: 'list_wallet_activity',
    description: 'List wallet ledger activity with pagination.',
    inputSchema: GetWalletActivitySchema,
    method: 'GET',
    endpoint: 'wallets',
    mutating: false,
    resolveEndpoint: (args) => `wallets/${encodeURIComponent(String(args.wallet_id))}/entries`,
    query: (args) => pickQuery(args, ['limit', 'offset']),
  },
  {
    name: 'list_sandbox_events',
    description: 'List recent sandbox webhook events for the configured test ledger.',
    inputSchema: ListSandboxEventsSchema,
    method: 'GET',
    endpoint: 'sandbox/events',
    mutating: false,
    query: (args) => pickQuery(args, ['event_type', 'limit']),
  },
  {
    name: 'upsert_user_wallet',
    description: '[WRITE] Create or upsert a consumer-credit wallet for a user.',
    inputSchema: CreateUserWalletSchema,
    method: 'POST',
    endpoint: 'wallets',
    mutating: true,
    body: (args) => ({
      owner_id: args.external_user_id,
      owner_type: 'user',
      wallet_type: 'consumer_credit',
      name: args.name,
      metadata: {
        ...(typeof args.metadata === 'object' && args.metadata ? args.metadata : {}),
        external_user_id: args.external_user_id,
      },
    }),
  },
  {
    name: 'create_wallet_session',
    description: '[WRITE] Create a short-lived hosted wallet page for a buyer wallet or creator earnings balance. Requires confirm=true.',
    inputSchema: CreateWalletSessionSchema,
    method: 'POST',
    endpoint: 'wallet-sessions',
    mutating: true,
    requireIdempotency: true,
    body: (args) => ({
      wallet_id: args.wallet_id,
      external_user_id: args.external_user_id,
      owner_type: args.owner_type,
      customer_email: args.customer_email,
      permissions: args.permissions,
      success_url: args.success_url,
      cancel_url: args.cancel_url,
      expires_in_minutes: args.expires_in_minutes,
      idempotency_key: args.idempotency_key,
      metadata: args.metadata,
    }),
  },
  {
    name: 'create_checkout',
    description: '[WRITE] Create a hosted or direct checkout. Requires confirm=true.',
    inputSchema: CreateCheckoutSchema,
    method: 'POST',
    endpoint: 'checkout-sessions',
    mutating: true,
    requireIdempotency: true,
    amountLimitCents: 100_000_00,
    body: (args) => ({
      amount: args.amount,
      participant_id: args.creator_id,
      currency: args.currency,
      product_id: args.external_product_id,
      product_name: args.product_name,
      customer_email: args.customer_email,
      customer_id: args.external_user_id,
      payment_method_id: args.payment_method_id,
      source_id: args.source_id,
      success_url: args.success_url,
      cancel_url: args.cancel_url,
      idempotency_key: args.idempotency_key,
      metadata: {
        ...(typeof args.metadata === 'object' && args.metadata ? args.metadata : {}),
        external_order_id: args.external_order_id,
      },
    }),
  },
  {
    name: 'complete_sandbox_checkout',
    description: '[WRITE] Complete a sandbox checkout without contacting a payment processor. Test API keys only. Requires confirm=true.',
    inputSchema: CompleteSandboxCheckoutSchema,
    method: 'POST',
    endpoint: 'sandbox',
    mutating: true,
    requireIdempotency: true,
    resolveEndpoint: (args) =>
      `sandbox/checkouts/${encodeURIComponent(String(args.checkout_session_id))}/complete`,
    body: (args) => ({
      idempotency_key: args.idempotency_key,
      payment_id: args.payment_id,
      metadata: args.metadata,
    }),
  },
  {
    name: 'fail_sandbox_checkout',
    description: '[WRITE] Mark a sandbox checkout as failed and queue the sandbox failure webhook. Test API keys only. Requires confirm=true.',
    inputSchema: FailSandboxCheckoutSchema,
    method: 'POST',
    endpoint: 'sandbox',
    mutating: true,
    requireIdempotency: true,
    resolveEndpoint: (args) =>
      `sandbox/checkouts/${encodeURIComponent(String(args.checkout_session_id))}/fail`,
    body: (args) => ({
      idempotency_key: args.idempotency_key,
      reason: args.reason,
      metadata: args.metadata,
    }),
  },
  {
    name: 'send_sandbox_webhook_test',
    description: '[WRITE] Queue a predefined sandbox webhook event. Test API keys only. Requires confirm=true.',
    inputSchema: SendSandboxWebhookTestSchema,
    method: 'POST',
    endpoint: 'sandbox/webhooks/test',
    mutating: true,
    requireIdempotency: true,
    body: (args) => ({
      idempotency_key: args.idempotency_key,
      event_type: args.event_type,
      payload: args.payload,
    }),
  },
  {
    name: 'request_refund',
    description: '[WRITE] Request a refund through Soledgic. Requires confirm=true.',
    inputSchema: RequestRefundSchema,
    method: 'POST',
    endpoint: 'refunds',
    mutating: true,
    requireIdempotency: true,
    amountLimitCents: 100_000_00,
    body: (args) => ({
      sale_reference: args.sale_reference,
      reason: args.reason,
      amount: args.amount,
      refund_from: args.refund_from,
      external_refund_id: args.external_refund_id,
      idempotency_key: args.idempotency_key,
      metadata: args.metadata,
    }),
  },
]

export function registerTools(server: Server) {
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS
      .filter((tool) => !allowedTools || allowedTools.has(tool.name))
      .map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: zodToJsonSchema(tool.inputSchema, tool.mutating, tool.requireIdempotency === true),
      })),
  }))

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: rawArgs = {} } = request.params
    const auditBase = { tool: name, actor, args_summary: summarizeArgs(rawArgs) }

    const tool = TOOLS.find((candidate) => candidate.name === name)
    if (!tool) {
      return errorResult(`Unknown tool: ${name}`, { ...auditBase, error: 'unknown tool' })
    }

    if (allowedTools && !allowedTools.has(name)) {
      return errorResult(`Tool "${name}" is not allowed.`, {
        ...auditBase,
        error: 'tool not allowed',
      })
    }

    const parsed = tool.inputSchema.safeParse(rawArgs)
    if (!parsed.success) {
      const message = parsed.error.issues
        .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
        .join(', ')
      return errorResult(`Validation error: ${message}`, {
        ...auditBase,
        error: `validation: ${message}`,
      })
    }

    const args = parsed.data as Record<string, unknown>
    const rateLimitError = checkRateLimit(name, tool.mutating)
    if (rateLimitError) {
      return errorResult(rateLimitError, { ...auditBase, error: 'rate limited' })
    }

    if (tool.mutating && !allowWrites) {
      return errorResult(
        'Writes are disabled. Set SOLEDGIC_ALLOW_WRITES=true to enable mutating tools.',
        { ...auditBase, error: 'writes disabled' },
      )
    }

    if (tool.mutating && isLiveKey(apiKey)) {
      return errorResult(
        'Live writes are blocked in the public Soledgic MCP. Use a test API key for MCP write tools.',
        { ...auditBase, error: 'live writes blocked' },
      )
    }

    if (tool.mutating && rawArgs.confirm !== true) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `This is a write operation (${name}). Re-call with confirm: true to execute. Arguments: ${summarizeArgs(args)}`,
          },
        ],
        isError: false,
      }
    }

    if (tool.requireIdempotency && !args.idempotency_key && !args.reference_id) {
      return errorResult(
        `Stable idempotency/reference field required for ${name}.`,
        { ...auditBase, error: 'missing idempotency/reference' },
      )
    }

    const amount = moneyAmount(args)
    if (amount !== null && tool.amountLimitCents && amount > tool.amountLimitCents) {
      const limit = (tool.amountLimitCents / 100).toLocaleString('en-US', {
        style: 'currency',
        currency: 'USD',
      })
      return errorResult(`Amount $${(amount / 100).toFixed(2)} exceeds ${limit} for ${name}.`, {
        ...auditBase,
        error: 'amount limit exceeded',
      })
    }

    if (name === 'get_integration_guide') {
      const guide = integrationGuide(String(args.topic))
      audit({
        timestamp: new Date().toISOString(),
        tool: name,
        actor,
        args_summary: summarizeArgs(args),
        request_id: null,
        success: true,
        error: null,
      })
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(guide, null, 2) }],
        isError: false,
      }
    }

    if (name === 'get_sdk_example') {
      const example = sdkExample(String(args.flow))
      audit({
        timestamp: new Date().toISOString(),
        tool: name,
        actor,
        args_summary: summarizeArgs(args),
        request_id: null,
        success: true,
        error: null,
      })
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(example, null, 2) }],
        isError: false,
      }
    }

    const endpoint = tool.resolveEndpoint ? tool.resolveEndpoint(args) : tool.endpoint
    const body = tool.body ? tool.body(args) : args
    const query = tool.query ? tool.query(args) : undefined
    const result = await apiRequest(tool.method, endpoint, tool.method === 'POST' ? body : undefined, query)

    audit({
      timestamp: new Date().toISOString(),
      tool: name,
      actor,
      args_summary: summarizeArgs(args),
      request_id: result.requestId,
      success: result.ok,
      error: result.ok
        ? null
        : ((result.data as { error?: string })?.error ?? 'Unknown error'),
    })

    return {
      content: [
        {
          type: 'text' as const,
          text: typeof result.data === 'string' ? result.data : JSON.stringify(result.data, null, 2),
        },
      ],
      isError: !result.ok,
    }
  })
}

function integrationGuide(topic: string) {
  const guides: Record<string, unknown> = {
    quickstart: {
      title: 'Quickstart',
      docs: `${DOCS_BASE_URL}/quickstart`,
      apiReference: `${DOCS_BASE_URL}/api`,
      summary: 'Install @soledgic/sdk, create a test API key, create a user wallet, upsert a creator, then create a checkout.',
    },
    wallets: {
      title: 'Wallets',
      docs: `${DOCS_BASE_URL}/concepts`,
      apiReference: `${DOCS_BASE_URL}/api#wallets`,
      summary: 'Wallets are scoped by ledger, owner, and wallet type. Do not treat them as one shared universal balance.',
    },
    creators: {
      title: 'Creators',
      docs: `${DOCS_BASE_URL}/concepts`,
      apiReference: `${DOCS_BASE_URL}/api#participants`,
      summary: 'Creators are participant-backed accounts. Portal access and payout readiness remain separate from financial existence.',
    },
    checkout: {
      title: 'Checkout',
      docs: `${DOCS_BASE_URL}/quickstart`,
      apiReference: `${DOCS_BASE_URL}/api#checkout-sessions`,
      summary: 'Create hosted checkout for user purchases and pass stable idempotency keys for retries.',
    },
    refunds: {
      title: 'Refunds',
      docs: `${DOCS_BASE_URL}/api#refunds`,
      apiReference: `${DOCS_BASE_URL}/api#refunds`,
      summary: 'Refunds should be requested through Soledgic so wallet, ledger, creator, and platform state stay consistent.',
    },
    webhooks: {
      title: 'Webhooks',
      docs: `${DOCS_BASE_URL}/webhooks`,
      apiReference: `${DOCS_BASE_URL}/api#webhooks`,
      summary: 'Use webhook signatures to verify Soledgic events before fulfilling orders or updating app state.',
    },
    sdks: {
      title: 'SDKs',
      docs: `${DOCS_BASE_URL}/sdks`,
      apiReference: `${DOCS_BASE_URL}/api`,
      summary: 'Use @soledgic/sdk for typed server-side integrations. Keep API keys on the server.',
    },
  }

  return guides[topic] || guides.quickstart
}

function sdkExample(flow: string) {
  const examples: Record<string, unknown> = {
    upsert_user_wallet: {
      install: 'npm install @soledgic/sdk',
      code: [
        "import SoledgicClient from '@soledgic/sdk'",
        '',
        'const soledgic = new SoledgicClient({ apiKey: process.env.SOLEDGIC_API_KEY! })',
        '',
        'await soledgic.users.upsertWallet({',
        "  externalUserId: 'user_123',",
        "  name: 'User 123 wallet',",
        '})',
      ].join('\n'),
    },
    create_wallet_session: {
      install: 'npm install @soledgic/sdk',
      code: [
        "import SoledgicClient from '@soledgic/sdk'",
        '',
        'const soledgic = new SoledgicClient({ apiKey: process.env.SOLEDGIC_API_KEY! })',
        '',
        'const session = await soledgic.walletSessions.create({',
        "  externalUserId: 'user_123',",
        "  ownerType: 'consumer',",
        "  customerEmail: 'buyer@example.com',",
        "  permissions: ['view_balance', 'list_activity'],",
        "  successUrl: 'https://example.com/account',",
        "  cancelUrl: 'https://example.com/account',",
        "  idempotencyKey: 'wallet_session_user_123_001',",
        '})',
        '',
        'return Response.redirect(session.walletSession.walletUrl)',
      ].join('\n'),
    },
    create_checkout: {
      install: 'npm install @soledgic/sdk',
      code: [
        "import SoledgicClient from '@soledgic/sdk'",
        '',
        'const soledgic = new SoledgicClient({ apiKey: process.env.SOLEDGIC_API_KEY! })',
        '',
        'await soledgic.orders.createCheckout({',
        "  creatorId: 'creator_456',",
        "  externalUserId: 'user_123',",
        "  externalOrderId: 'order_1001',",
        '  amount: 999,',
        "  currency: 'USD',",
        "  productName: 'Chapter 1',",
        "  successUrl: 'https://example.com/success',",
        "  cancelUrl: 'https://example.com/cancel',",
        "  idempotencyKey: 'order_1001_checkout',",
        '})',
      ].join('\n'),
    },
    request_refund: {
      install: 'npm install @soledgic/sdk',
      code: [
        "import SoledgicClient from '@soledgic/sdk'",
        '',
        'const soledgic = new SoledgicClient({ apiKey: process.env.SOLEDGIC_API_KEY! })',
        '',
        'await soledgic.refunds.request({',
        "  saleReference: 'sale_123',",
        "  reason: 'Customer requested refund',",
        "  idempotencyKey: 'refund_sale_123_001',",
        '})',
      ].join('\n'),
    },
    webhook_verification: {
      install: 'npm install @soledgic/sdk',
      code: [
        "import { verifyWebhookSignature } from '@soledgic/sdk'",
        '',
        'const valid = await verifyWebhookSignature(',
        '  rawBody,',
        "  request.headers.get('x-soledgic-signature')!,",
        '  process.env.SOLEDGIC_WEBHOOK_SECRET!,',
        ')',
      ].join('\n'),
    },
  }

  return examples[flow] || examples.create_checkout
}

function zodToJsonSchema(
  schema: z.ZodType,
  mutating: boolean,
  requireIdempotency: boolean,
): Record<string, unknown> {
  const jsonSchema = zodToObj(schema)

  if (
    mutating &&
    jsonSchema.type === 'object' &&
    typeof jsonSchema.properties === 'object'
  ) {
    const props = jsonSchema.properties as Record<string, unknown>
    props.confirm = {
      type: 'boolean',
      description: 'Must be true to execute this write operation.',
    }
    if (requireIdempotency && !props.idempotency_key) {
      props.idempotency_key = {
        type: 'string',
        description: 'Stable retry key for this operation.',
      }
    }
  }

  return jsonSchema
}

function zodToObj(schema: z.ZodType): Record<string, unknown> {
  if (schema instanceof z.ZodOptional || schema instanceof z.ZodDefault) {
    return zodToObj((schema as z.ZodOptional<z.ZodType>)._def.innerType)
  }

  if (schema instanceof z.ZodObject) {
    const shape = schema.shape as Record<string, z.ZodType>
    const properties: Record<string, unknown> = {}
    const required: string[] = []

    for (const [key, value] of Object.entries(shape)) {
      properties[key] = zodToObj(value)
      if (!(value instanceof z.ZodOptional || value instanceof z.ZodDefault)) {
        required.push(key)
      }
    }

    const result: Record<string, unknown> = { type: 'object', properties }
    if (required.length > 0) result.required = required
    return result
  }

  if (schema instanceof z.ZodString) {
    return {
      type: 'string',
      ...(schema.description ? { description: schema.description } : {}),
    }
  }

  if (schema instanceof z.ZodNumber) {
    return {
      type: 'number',
      ...(schema.description ? { description: schema.description } : {}),
    }
  }

  if (schema instanceof z.ZodBoolean) {
    return {
      type: 'boolean',
      ...(schema.description ? { description: schema.description } : {}),
    }
  }

  if (schema instanceof z.ZodEnum) {
    return {
      type: 'string',
      enum: schema.options,
      ...(schema.description ? { description: schema.description } : {}),
    }
  }

  if (schema instanceof z.ZodArray) {
    return {
      type: 'array',
      items: zodToObj(schema._def.element as z.ZodType),
      ...(schema.description ? { description: schema.description } : {}),
    }
  }

  if (schema instanceof z.ZodRecord) {
    return {
      type: 'object',
      additionalProperties: true,
      ...(schema.description ? { description: schema.description } : {}),
    }
  }

  return { type: 'object' }
}
