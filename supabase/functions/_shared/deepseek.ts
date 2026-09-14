// Cliente compartilhado da DeepSeek.
//
// Por que existe: quando os servidores da DeepSeek estao sobrecarregados, a API
// NAO devolve 429 — ela mantem a conexao aberta e deixa a requisicao na fila,
// podendo nunca responder. Sem timeout, a Edge Function fica presa ate o limite
// de 150s da plataforma e o app recebe 504 (IDLE_TIMEOUT) ou 546
// (WORKER_RESOURCE_LIMIT), sem mensagem nenhuma para o usuario.
//
// Aqui cada tentativa tem timeout proprio e a chamada e repetida enquanto houver
// tempo dentro do prazo da requisicao, sempre terminando antes do limite da
// plataforma para que o app receba uma mensagem de erro clara.

export const LIMITE_PLATAFORMA_MS = 150000

export type MensagemIA = { role: string; content: string }

export type OpcoesIA = {
  messages: MensagemIA[]
  maxTokens: number
  temperature?: number
  json?: boolean
  prazo: number          // timestamp (ms) em que devemos desistir
  tentativaMs?: number   // timeout de cada tentativa
  tentativas?: number
}

// Prazo absoluto para a requisicao inteira, com folga para responder antes
// de a plataforma derrubar a funcao.
export function prazoPadrao(ms = 110000) {
  return Date.now() + Math.min(ms, LIMITE_PLATAFORMA_MS - 20000)
}

export class ErroIA extends Error {
  readonly temporario: boolean
  constructor(mensagem: string, temporario = false) {
    super(mensagem)
    this.name = 'ErroIA'
    this.temporario = temporario
  }
}

const dormir = (ms: number) => new Promise(res => setTimeout(res, ms))

export async function deepseekChat(op: OpcoesIA): Promise<{ content: string; finishReason: string }> {
  const chave = Deno.env.get('DEEPSEEK_API_KEY')
  if (!chave) throw new ErroIA('A chave da IA (DEEPSEEK_API_KEY) não está configurada no projeto.')

  const maxTentativas = op.tentativas ?? 3
  const tentativaMs = op.tentativaMs ?? 45000
  let ultimoErro: Error | null = null

  for (let tentativa = 1; tentativa <= maxTentativas; tentativa++) {
    const restante = op.prazo - Date.now()
    if (restante < 8000) break

    const ctrl = new AbortController()
    const timeout = setTimeout(() => ctrl.abort(), Math.min(tentativaMs, restante))
    let r: Response
    let bruto: string
    try {
      r = await fetch('https://api.deepseek.com/chat/completions', {
        method: 'POST',
        signal: ctrl.signal,
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${chave}`,
        },
        body: JSON.stringify({
          model: 'deepseek-chat',
          messages: op.messages,
          ...(op.json ? { response_format: { type: 'json_object' } } : {}),
          temperature: op.temperature ?? 0.5,
          max_tokens: Math.min(Math.max(Math.round(op.maxTokens), 200), 8000),
        }),
      })
      // O corpo e' lido DENTRO do try, com o timeout ainda armado: quando a
      // DeepSeek esta congestionada ela devolve os headers na hora e segura o
      // corpo enquanto a requisicao espera na fila. Ler depois de limpar o
      // timer deixaria a funcao presa ate a plataforma matar o worker (546/504).
      bruto = await r.text()
    } catch (e) {
      // Timeout (fila da DeepSeek) ou falha de rede: vale tentar de novo.
      ultimoErro = (e as Error)?.name === 'AbortError'
        ? new ErroIA('A IA não respondeu a tempo.', true)
        : new ErroIA(`Falha de conexão com a IA: ${(e as Error)?.message || e}`, true)
      console.error('deepseek tentativa', tentativa, ultimoErro.message)
      continue
    } finally {
      clearTimeout(timeout)
    }

    if (!r.ok) {
      const err = bruto.slice(0, 1000)
      console.error('deepseek HTTP', r.status, err)
      if (r.status === 401) throw new ErroIA('Chave da DeepSeek inválida (verifique o segredo DEEPSEEK_API_KEY).')
      if (r.status === 402) throw new ErroIA('A conta da DeepSeek está sem créditos. Recarregue o saldo para voltar a usar a IA.')
      if (r.status === 400) throw new ErroIA(`A IA recusou o pedido: ${err.slice(0, 200)}`)
      // 429 e 5xx sao temporarios.
      ultimoErro = new ErroIA(`A IA está sobrecarregada (erro ${r.status}).`, true)
      await dormir(1500)
      continue
    }

    let data: any
    try {
      data = JSON.parse(bruto)
    } catch {
      ultimoErro = new ErroIA('A IA devolveu uma resposta ilegível.', true)
      continue
    }
    const content: string = data.choices?.[0]?.message?.content ?? ''
    const finishReason: string = data.choices?.[0]?.finish_reason ?? ''
    if (!content.trim()) {
      ultimoErro = new ErroIA('A IA não retornou conteúdo.', true)
      continue
    }
    return { content, finishReason }
  }

  throw ultimoErro ?? new ErroIA('Não foi possível falar com a IA agora.', true)
}

// Erro final quando todas as tentativas se esgotaram por congestionamento.
export function mensagemDeFalha(e: unknown) {
  if (e instanceof ErroIA && e.temporario) {
    return 'A IA está demorando demais para responder (servidores da DeepSeek congestionados). Tente novamente em alguns minutos.'
  }
  return e instanceof Error && e.message ? e.message : String(e)
}
