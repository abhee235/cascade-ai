// scripts/mock-openai-endpoint.ts — a stand-in for a remote vLLM/SGLang box, so you can test the Model
// Manager "Custom endpoint" flow (ADR-076) WITHOUT renting a GPU. It speaks just enough of the OpenAI API:
//   • GET  /v1/models            → a fake catalog (drives the connection test + listModels)
//   • POST /v1/chat/completions  → a canned reply (streaming SSE when {stream:true}, else JSON)
// It also checks the Authorization: Bearer header and LOGS every request, so you can see exactly what Cascade
// sends and confirm your API key arrives.
//
//   bun scripts/mock-openai-endpoint.ts [--port 8000] [--key sk-test]
// Then in the Model Manager → Custom endpoint:
//   Provider label: mock · Model id: mock-model · Endpoint URL: http://localhost:8000/v1 · API key: sk-test

const args = new Map<string, string>()
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i].replace(/^--/, ''), process.argv[i + 1])
const PORT = Number(args.get('port') ?? 8000)
const KEY = args.get('key') ?? 'sk-test'
const MODEL = 'mock-model'

const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a)

function authOk(req: Request): boolean {
  const h = req.headers.get('authorization') ?? ''
  return h === `Bearer ${KEY}` // exact match — proves the key is flowing
}

// One canned assistant reply, streamed word-by-word as OpenAI SSE chunks.
function streamReply(text: string): Response {
  const enc = new TextEncoder()
  const words = text.split(' ')
  const stream = new ReadableStream({
    start(c) {
      const id = 'chatcmpl-mock'
      const base = { id, object: 'chat.completion.chunk', created: 1, model: MODEL }
      c.enqueue(enc.encode(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: 'assistant' } }] })}\n\n`))
      for (const w of words) c.enqueue(enc.encode(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { content: `${w} ` } }] })}\n\n`))
      c.enqueue(enc.encode(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`))
      c.enqueue(enc.encode('data: [DONE]\n\n'))
      c.close()
    },
  })
  return new Response(stream, { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' } })
}

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url)
    log(req.method, url.pathname, '| auth:', authOk(req) ? 'OK' : 'MISSING/WRONG')
    if (!authOk(req)) return Response.json({ error: { message: 'invalid api key' } }, { status: 401 })

    if (url.pathname === '/v1/models') {
      return Response.json({ object: 'list', data: [{ id: MODEL, object: 'model', owned_by: 'mock' }] })
    }
    if (url.pathname === '/v1/chat/completions') {
      const body = (await req.json().catch(() => ({}))) as { stream?: boolean; messages?: { role: string; content: unknown }[] }
      const lastUser = [...(body.messages ?? [])].reverse().find((m) => m.role === 'user')
      log('  ↳ messages:', body.messages?.length ?? 0, '| stream:', !!body.stream, '| last user:', JSON.stringify(lastUser?.content).slice(0, 80))
      const reply = `Mock endpoint is working. I received ${body.messages?.length ?? 0} messages. This confirms Cascade connected, authenticated, and streamed a response.`
      if (body.stream) return streamReply(reply)
      return Response.json({ id: 'chatcmpl-mock', object: 'chat.completion', created: 1, model: MODEL, choices: [{ index: 0, message: { role: 'assistant', content: reply }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 } })
    }
    return new Response('mock OpenAI endpoint — try /v1/models or /v1/chat/completions', { status: 404 })
  },
})

log(`mock OpenAI endpoint on http://localhost:${server.port}/v1  (key: ${KEY}, model: ${MODEL})`)
log('add it in the Model Manager → Custom endpoint, then switch to it and send a message.')
