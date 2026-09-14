// Cliente de IA compartilhado pelas Edge Functions.
//
// Por que existe: quando os servidores da DeepSeek estao sobrecarregados, a API
// NAO devolve 429 — ela responde os headers na hora e segura o CORPO da resposta
// enquanto a requisicao espera na fila, podendo nunca completar. Sem timeout
// cobrindo a leitura do corpo, a Edge Function fica presa ate o limite de 150s
// da plataforma e o app recebe 504 (IDLE_TIMEOUT) ou 546 (WORKER_RESOURCE_LIMIT),
// sem mensagem nenhuma para o usuario.
//
// Aqui cada tentativa tem timeout proprio que cobre headers E corpo, e a chamada
// e' repetida enquanto houver tempo — sempre terminando antes do limite da
// plataforma para que o app receba uma mensagem de erro clara.

export const LIMITE_PLATAFORMA_MS = 150000

export type MensagemIA = { role: string; content: string }

type Provedor = {
  nome: string
  url: string
  env: string
  modelo: string
  tentativas: number
  tentativaMs: number
}

// Unico provedor em uso. A lista existe para permitir acrescentar outro no
// futuro sem mexer nas funcoes: um provedor sem chave configurada e' pulado.
const PROVEDORES: Provedor[] = [
  {
    nome: 'DeepSeek',
    url: 'https://api.deepseek.com/chat/completions',
    env: 'DEEPSEEK_API_KEY',
    modelo: 'deepseek-chat',
    tentativas: 3,
    tentativaMs: 35000,
  },
]

export type OpcoesIA = {
  messages: MensagemIA[]
  maxTokens: number
  temperature?: number
  json?: boolean
  prazo: number   // timestamp (ms) em que devemos desistir
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

type Resultado = { content: string; finishReason: string; provedor: string }

// Uma tentativa em um provedor. Devolve o resultado ou lanca ErroIA
// (temporario = vale repetir; definitivo = problema de chave/pedido).
async function tentarProvedor(p: Provedor, chave: string, op: OpcoesIA, tentativaMs: number): Promise<Resultado> {
  const ctrl = new AbortController()
  const timeout = setTimeout(() => ctrl.abort(), tentativaMs)
  let r: Response
  let bruto: string
  try {
    r = await fetch(p.url, {
      method: 'POST',
      signal: ctrl.signal,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${chave}`,
      },
      body: JSON.stringify({
        model: p.modelo,
        messages: op.messages,
        ...(op.json ? { response_format: { type: 'json_object' } } : {}),
        temperature: op.temperature ?? 0.5,
        max_tokens: Math.min(Math.max(Math.round(op.maxTokens), 200), 8000),
      }),
    })
    // O corpo e' lido DENTRO do try, com o timeout ainda armado: e' aqui que a
    // DeepSeek congestionada trava. Ler depois de limpar o timer deixaria a
    // funcao presa ate a plataforma matar o worker.
    bruto = await r.text()
  } catch (e) {
    throw (e as Error)?.name === 'AbortError'
      ? new ErroIA(`${p.nome}: não respondeu a tempo (fila/congestionamento).`, true)
      : new ErroIA(`${p.nome}: falha de conexão (${(e as Error)?.message || e}).`, true)
  } finally {
    clearTimeout(timeout)
  }

  if (!r.ok) {
    console.error(p.nome, 'HTTP', r.status, bruto.slice(0, 500))
    if (r.status === 401) throw new ErroIA(`${p.nome}: chave inválida (confira o segredo ${p.env}).`)
    if (r.status === 402) throw new ErroIA(`${p.nome}: conta sem créditos.`)
    if (r.status === 400) throw new ErroIA(`${p.nome}: pedido recusado (${bruto.slice(0, 150)}).`)
    throw new ErroIA(`${p.nome}: sobrecarregado (erro ${r.status}).`, true)
  }

  let data: any
  try {
    data = JSON.parse(bruto)
  } catch {
    throw new ErroIA(`${p.nome}: resposta ilegível.`, true)
  }
  const content: string = data.choices?.[0]?.message?.content ?? ''
  if (!content.trim()) throw new ErroIA(`${p.nome}: não retornou conteúdo.`, true)
  return { content, finishReason: data.choices?.[0]?.finish_reason ?? '', provedor: p.nome }
}

export async function chamarIA(op: OpcoesIA): Promise<Resultado> {
  const disponiveis = PROVEDORES
    .map(p => ({ p, chave: Deno.env.get(p.env) || '' }))
    .filter(x => !!x.chave)

  if (!disponiveis.length) {
    throw new ErroIA('A chave da IA (DEEPSEEK_API_KEY) não está configurada no projeto.')
  }

  const falhas: string[] = []

  for (const { p, chave } of disponiveis) {
    for (let tentativa = 1; tentativa <= p.tentativas; tentativa++) {
      const restante = op.prazo - Date.now()
      if (restante < 6000) {
        falhas.push(`${p.nome}: sem tempo hábil.`)
        break
      }
      try {
        return await tentarProvedor(p, chave, op, Math.min(p.tentativaMs, restante))
      } catch (e) {
        const erro = e instanceof ErroIA ? e : new ErroIA(String(e), true)
        console.error('IA falhou:', erro.message)
        if (!erro.temporario) {
          // Problema de chave/pedido: repetir no mesmo provedor nao adianta.
          falhas.push(erro.message)
          break
        }
        if (tentativa === p.tentativas) falhas.push(erro.message)
        else await dormir(1000)
      }
    }
  }

  throw new ErroIA(`A IA não respondeu. ${falhas.join(' ')}`, true)
}

export function mensagemDeFalha(e: unknown) {
  if (e instanceof Error && e.message) return e.message
  return String(e)
}
