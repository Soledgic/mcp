import { z } from 'zod'

const MetadataSchema = z.record(z.string(), z.unknown()).optional().describe('Optional integration metadata')

export const EmptySchema = z.object({})

export const IntegrationGuideSchema = z.object({
  topic: z.enum([
    'quickstart',
    'wallets',
    'creators',
    'checkout',
    'refunds',
    'webhooks',
    'sdks',
  ]).describe('Integration topic'),
})

export const SdkExampleSchema = z.object({
  flow: z.enum([
    'upsert_user_wallet',
    'create_wallet_session',
    'create_checkout',
    'request_refund',
    'webhook_verification',
  ]).describe('Example flow'),
})

export const GetWalletActivitySchema = z.object({
  wallet_id: z.string().min(1).describe('Wallet id'),
  limit: z.number().int().min(1).max(100).optional(),
  offset: z.number().int().min(0).optional(),
})

export const CreateUserWalletSchema = z.object({
  external_user_id: z.string().min(1).describe('Your user id'),
  name: z.string().optional().describe('Wallet display name'),
  metadata: MetadataSchema,
})

export const CreateWalletSessionSchema = z.object({
  wallet_id: z.string().uuid().optional().describe('Existing Soledgic wallet id'),
  external_user_id: z.string().optional().describe('Your user id for consumer sessions, or participant id for creator earnings sessions when wallet_id is omitted'),
  owner_type: z.enum(['user', 'consumer', 'participant', 'creator'])
    .default('user')
    .describe('Use user/consumer for buyer wallet sessions; use participant/creator for creator earnings sessions'),
  customer_email: z.string().email().optional(),
  permissions: z.array(z.enum(['view_balance', 'list_activity', 'top_up', 'request_refund']))
    .min(1)
    .max(4)
    .default(['view_balance', 'list_activity'])
    .describe('Hosted wallet permissions'),
  success_url: z.string().url().optional(),
  cancel_url: z.string().url().optional(),
  expires_in_minutes: z.number().int().min(1).max(1440).default(30),
  idempotency_key: z.string().min(8).describe('Stable retry key for this wallet session'),
  metadata: MetadataSchema,
}).superRefine((value, ctx) => {
  if (!value.wallet_id && !value.external_user_id) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['external_user_id'],
      message: 'external_user_id is required when wallet_id is omitted',
    })
  }
  if ((value.owner_type === 'participant' || value.owner_type === 'creator') && value.permissions?.some((permission) => permission === 'top_up' || permission === 'request_refund')) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['permissions'],
      message: 'creator earnings sessions only support view_balance and list_activity',
    })
  }
})

export const CreateCheckoutSchema = z.object({
  creator_id: z.string().min(1).describe('Creator participant id'),
  amount: z.number().int().positive().describe('Amount in cents'),
  currency: z.string().length(3).default('USD').describe('Three-letter currency code'),
  external_user_id: z.string().optional().describe('Your buyer/user id'),
  customer_email: z.string().email().optional(),
  external_product_id: z.string().optional().describe('Your product id'),
  external_order_id: z.string().optional().describe('Your order id'),
  product_name: z.string().optional(),
  success_url: z.string().url().optional().describe('Return URL for hosted checkout'),
  cancel_url: z.string().url().optional(),
  payment_method_id: z.string().optional().describe('Direct-charge payment method id'),
  source_id: z.string().optional().describe('Direct-charge source id'),
  idempotency_key: z.string().min(8).describe('Stable retry key for this checkout'),
  metadata: MetadataSchema,
}).superRefine((value, ctx) => {
  if (!value.success_url && !value.payment_method_id && !value.source_id) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['success_url'],
      message: 'success_url is required unless payment_method_id or source_id is provided',
    })
  }
})

export const RequestRefundSchema = z.object({
  sale_reference: z.string().min(1).describe('Sale reference to refund'),
  reason: z.string().min(3).describe('Refund reason'),
  amount: z.number().int().positive().optional().describe('Amount in cents; omit for full refund'),
  refund_from: z.enum(['both', 'platform_only', 'creator_only']).optional(),
  external_refund_id: z.string().optional(),
  idempotency_key: z.string().min(8).describe('Stable retry key for this refund'),
  metadata: MetadataSchema,
})

export const CompleteSandboxCheckoutSchema = z.object({
  checkout_session_id: z.string().uuid().describe('Sandbox checkout session id'),
  idempotency_key: z.string().min(8).describe('Stable retry key for this sandbox action'),
  payment_id: z.string().optional().describe('Optional fake sandbox payment id'),
  metadata: MetadataSchema,
})

export const FailSandboxCheckoutSchema = z.object({
  checkout_session_id: z.string().uuid().describe('Sandbox checkout session id'),
  idempotency_key: z.string().min(8).describe('Stable retry key for this sandbox action'),
  reason: z.string().optional().describe('Sandbox failure reason'),
  metadata: MetadataSchema,
})

export const SendSandboxWebhookTestSchema = z.object({
  idempotency_key: z.string().min(8).describe('Stable retry key for this sandbox event'),
  event_type: z.enum([
    'sandbox.test',
    'checkout.completed',
    'checkout.failed',
    'refund.created',
    'sale.refunded',
  ]).default('sandbox.test').describe('Predefined sandbox webhook event'),
  payload: z.record(z.string(), z.unknown()).optional().describe('Optional safe sandbox payload fields'),
})

export const ListSandboxEventsSchema = z.object({
  event_type: z.string().optional().describe('Optional webhook event type filter'),
  limit: z.number().int().min(1).max(100).optional(),
})
