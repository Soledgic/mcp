import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { configure, normalizeBaseUrl, registerTools } from './tools.js'

const apiKey = process.env.SOLEDGIC_API_KEY

if (!apiKey) {
  process.stderr.write('FATAL: SOLEDGIC_API_KEY is required.\n')
  process.exit(1)
}

if (!/^slk_(live|test)_[A-Za-z0-9]+$/.test(apiKey)) {
  process.stderr.write('FATAL: SOLEDGIC_API_KEY must match slk_live_* or slk_test_* format.\n')
  process.exit(1)
}

const baseUrl = normalizeBaseUrl(process.env.SOLEDGIC_BASE_URL || 'https://api.soledgic.com/v1')
const allowWrites = process.env.SOLEDGIC_ALLOW_WRITES === 'true'
const actor = process.env.SOLEDGIC_ACTOR || 'public-mcp'
const allowedToolsRaw = process.env.SOLEDGIC_ALLOWED_TOOLS
const allowedTools = allowedToolsRaw
  ? allowedToolsRaw.split(',').map((tool) => tool.trim()).filter(Boolean)
  : null

const isLive = apiKey.startsWith('slk_live_')

process.stderr.write(
  `${JSON.stringify({
    event: 'soledgic_public_mcp_start',
    timestamp: new Date().toISOString(),
    key_type: isLive ? 'live' : 'test',
    base_url: baseUrl,
    allow_writes: allowWrites,
    live_writes: 'blocked',
    allowed_tools: allowedTools ?? 'all',
    actor,
  })}\n`,
)

if (!allowWrites) {
  process.stderr.write('INFO: read-only mode. Set SOLEDGIC_ALLOW_WRITES=true to enable mutating tools.\n')
}

if (isLive) {
  process.stderr.write('INFO: live key detected. Read tools are available; public MCP write tools are blocked for live keys.\n')
}

configure({
  apiKey,
  baseUrl,
  allowWrites,
  allowedTools,
  actor,
})

const server = new Server(
  {
    name: 'soledgic-public',
    version: '0.1.1',
  },
  {
    capabilities: {
      tools: {},
    },
  },
)

registerTools(server)

const transport = new StdioServerTransport()
await server.connect(transport)

process.stderr.write('Soledgic public MCP server running on stdio\n')
