import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { chamarIA, mensagemDeFalha, prazoPadrao, ErroIA } from "../_shared/ia.ts"

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Content-Type': 'application/json',
}

// Questoes por chamada. Lotes pequenos respondem mais rapido e cabem com folga
// no limite de tokens de saida do modelo.
const LOTE = 5

async function gerarJSON(prompt: string, maxTokens: number, prazo: number, temperature = 0.5) {
  const { content, finishReason } = await chamarIA({
    messages: [{ role: 'user', content: prompt }],
    maxTokens, temperature, json: true, prazo,
  })
  try {
    return JSON.parse(content)
  } catch {
    if (finishReason === 'length') {
      throw new ErroIA('A resposta da IA foi cortada por tamanho. Tente gerar menos questões por vez.')
    }
    throw new ErroIA('A IA retornou um formato inválido. Tente novamente.', true)
  }
}

// Quebra a geracao em lotes paralelos de ate LOTE questoes: cada chamada fica
// curta e o tempo total e o da chamada mais lenta, nao a soma delas.
async function gerarEmLotes(qtd: number, prazo: number, montarPrompt: (n: number, i: number, total: number) => string) {
  const lotes: number[] = []
  for (let rest = qtd; rest > 0; rest -= LOTE) lotes.push(Math.min(LOTE, rest))

  const res = await Promise.allSettled(
    lotes.map((n, i) => gerarJSON(montarPrompt(n, i, lotes.length), 800 * n + 600, prazo, lotes.length > 1 ? 0.7 : 0.5))
  )

  const ok = res.filter(r => r.status === 'fulfilled').map(r => (r as PromiseFulfilledResult<any>).value)
  if (!ok.length) {
    const primeiro = res.find(r => r.status === 'rejected') as PromiseRejectedResult | undefined
    throw primeiro?.reason instanceof Error ? primeiro.reason : new ErroIA('Não foi possível gerar as questões.', true)
  }

  // Lotes nao se enxergam, entao descartamos enunciados repetidos.
  const vistos = new Set<string>()
  const questoes: any[] = []
  for (const bloco of ok) {
    for (const q of (Array.isArray(bloco?.questoes) ? bloco.questoes : [])) {
      const chave = String(q?.enunciado || '').toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 120)
      if (!chave || vistos.has(chave)) continue
      vistos.add(chave)
      questoes.push(q)
    }
  }
  return { titulo: ok.find(b => b?.titulo)?.titulo || '', questoes: questoes.slice(0, qtd) }
}

function clampQuestao(q: any) {
  const tipo = q?.tipo === 'subjetiva' || q?.tipo === 'redacao' ? q.tipo : 'multipla'
  const enunciado = String(q?.enunciado || '').slice(0, 2000)
  if (tipo === 'subjetiva') {
    return {
      tipo, enunciado,
      gabarito: String(q?.gabarito || '').slice(0, 2000),
      criterios: String(q?.criterios || '').slice(0, 1000),
      pontos: Math.min(Math.max(Number(q?.pontos) || 5, 0.5), 100),
      imagemUrl: null,
    }
  }
  if (tipo === 'redacao') {
    return {
      tipo, enunciado,
      proposta: String(q?.proposta || '').slice(0, 4000),
      criterios: String(q?.criterios || '').slice(0, 1000),
      pontos: Math.min(Math.max(Number(q?.pontos) || 1000, 1), 1000),
      imagemUrl: null,
    }
  }
  const opcoesIn = Array.isArray(q?.opcoes) ? q.opcoes.map((o: any) => String(o || '').slice(0, 500)) : []
  const opcoes = [0, 1, 2, 3, 4].map(i => opcoesIn[i] || '')
  let correta = Number.isInteger(q?.correta) ? q.correta : parseInt(q?.correta)
  if (!(correta >= 0 && correta <= 4)) correta = null
  return { tipo: 'multipla', enunciado, opcoes, correta, imagemUrl: null }
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })

  const prazo = prazoPadrao()

  try {
    const { tipo, disciplina, tema, nivel, quantidade, tipoQuestao, contextoAulas, contextoAula } = await req.json()

    if (!disciplina || !tema) {
      return new Response(JSON.stringify({ error: 'Preencha disciplina e tema.', erroMsg: 'Preencha disciplina e tema.' }), { status: 400, headers: CORS })
    }
    const nivelTxt = nivel === 'facil' ? 'fácil' : nivel === 'dificil' ? 'difícil' : 'médio'

    if (tipo === 'aula') {
      const prompt = `Você é um professor brasileiro criando o material de uma aula para uma turma do ensino médio/fundamental.

Disciplina: ${disciplina}
Tema da aula: ${tema}
Nível de dificuldade: ${nivelTxt}

Crie o conteúdo da aula em português, didático e organizado, usando SOMENTE estas tags HTML simples: <p>, <strong>, <em>, <ul>, <li>, <br>. Não use markdown, não use <script>, <style> ou atributos.

Retorne APENAS um JSON com dois campos:
- "titulo": título curto e atrativo para a aula
- "conteudo": o conteúdo da aula em HTML simples (várias seções: introdução, explicação, exemplos), com pelo menos 4 parágrafos`

      const result = await gerarJSON(prompt, 3000, prazo)
      return new Response(JSON.stringify({
        tipo: 'aula',
        titulo: String(result?.titulo || tema).slice(0, 200),
        conteudo: String(result?.conteudo || '').slice(0, 20000),
      }), { headers: CORS })
    }

    if (tipo === 'prova') {
      let qtd = parseInt(quantidade)
      if (!Number.isInteger(qtd)) qtd = 5
      qtd = Math.min(Math.max(qtd, 0), 15)
      if (tipoQuestao === 'redacao') qtd = Math.min(qtd, 1)

      if (qtd === 0) {
        return new Response(JSON.stringify({
          tipo: 'prova', titulo: String(tema).slice(0, 200), disciplina: String(disciplina).slice(0, 100), questoes: [],
        }), { headers: CORS })
      }

      const tqMap: Record<string, string> = {
        multipla: 'todas as questões devem ser de MÚLTIPLA ESCOLHA (5 alternativas, uma correta)',
        subjetiva: 'todas as questões devem ser DISSERTATIVAS (o aluno escreve a resposta, sem alternativas)',
        redacao: 'gere apenas 1 questão do tipo REDAÇÃO (proposta de redação estilo ENEM)',
        mista: 'misture questões de múltipla escolha e dissertativas',
      }
      const instrucaoTipo = tqMap[tipoQuestao] || tqMap.multipla
      const contextoBloco = contextoAulas
        ? `Baseie as questões no seguinte conteúdo de aula(s) já ministradas em sala (e, se houver, exercícios já aplicados). Crie questões NOVAS e inéditas testando a compreensão desse conteúdo — não copie perguntas prontas do material:\n"""\n${String(contextoAulas).slice(0, 6000)}\n"""\n\n`
        : ''

      const montarPrompt = (n: number, i: number, total: number) => `Você é um professor brasileiro elaborando uma prova/avaliação.

${contextoBloco}Disciplina: ${disciplina}
Tema: ${tema}
Nível de dificuldade: ${nivelTxt}
Quantidade de questões: ${n}
Instrução sobre os tipos de questão: ${instrucaoTipo}
${total > 1 ? `\nEsta é a parte ${i + 1} de ${total} da prova. Aborde subtemas e habilidades diferentes das outras partes, para que não haja questões repetidas.\n` : ''}
Retorne APENAS um JSON no formato:
{
  "titulo": "título curto da prova",
  "disciplina": "${disciplina}",
  "questoes": [
    // para múltipla escolha: {"tipo":"multipla","enunciado":"...","opcoes":["...","...","...","...","..."],"correta":0}
    // (correta é o índice de 0 a 4 da alternativa certa; sempre gere exatamente 5 alternativas plausíveis)
    // para dissertativa: {"tipo":"subjetiva","enunciado":"...","gabarito":"resposta esperada","criterios":"critérios de correção","pontos":5}
    // para redação: {"tipo":"redacao","enunciado":"tema da redação","proposta":"proposta completa com textos motivadores e comando","criterios":"","pontos":1000}
  ]
}
Gere exatamente ${n} questão(ões), seguindo a instrução sobre os tipos.`

      const result = tipoQuestao === 'redacao'
        ? await gerarJSON(montarPrompt(1, 0, 1), 3000, prazo)
        : await gerarEmLotes(qtd, prazo, montarPrompt)

      const questoesRaw = Array.isArray(result?.questoes) ? result.questoes.slice(0, qtd) : []
      const questoes = questoesRaw.map(clampQuestao)

      return new Response(JSON.stringify({
        tipo: 'prova',
        titulo: String(result?.titulo || tema).slice(0, 200),
        disciplina: String((result as any)?.disciplina || disciplina).slice(0, 100),
        questoes,
      }), { headers: CORS })
    }

    if (tipo === 'exercicio') {
      let qtd = parseInt(quantidade)
      if (!Number.isInteger(qtd) || qtd < 1) qtd = 5
      qtd = Math.min(qtd, 15)

      const contextoBloco = contextoAula
        ? `Conteúdo da aula (baseie as questões nele):\n"""\n${String(contextoAula).slice(0, 6000)}\n"""\n\n`
        : ''

      const montarPrompt = (n: number, i: number, total: number) => `Você é um professor brasileiro criando um exercício de fixação de múltipla escolha para os alunos praticarem o conteúdo de uma aula específica.

${contextoBloco}Disciplina: ${disciplina}
Aula: ${tema}
Nível de dificuldade: ${nivelTxt}
${total > 1 ? `\nEsta é a parte ${i + 1} de ${total} do exercício. Aborde trechos e habilidades diferentes das outras partes, para não repetir questões.\n` : ''}
Gere exatamente ${n} questões de múltipla escolha (5 alternativas cada, uma correta), testando a compreensão do conteúdo acima.

Retorne APENAS um JSON no formato:
{
  "titulo": "título curto para o exercício (ex: Exercícios de Fixação — <tema da aula>)",
  "questoes": [{"tipo":"multipla","enunciado":"...","opcoes":["...","...","...","...","..."],"correta":0}]
}`

      const result = await gerarEmLotes(qtd, prazo, montarPrompt)
      const questoesRaw = Array.isArray(result?.questoes) ? result.questoes.slice(0, qtd) : []
      const questoes = questoesRaw.map(clampQuestao).map((q: any) => ({ ...q, tipo: 'multipla' }))

      return new Response(JSON.stringify({
        tipo: 'exercicio',
        titulo: String(result?.titulo || `Exercícios de Fixação — ${tema}`).slice(0, 200),
        questoes,
      }), { headers: CORS })
    }

    return new Response(JSON.stringify({ error: 'Tipo inválido. Use "aula", "prova" ou "exercicio".', erroMsg: 'Tipo inválido.' }), { status: 400, headers: CORS })
  } catch (e) {
    const msg = mensagemDeFalha(e)
    console.error('gerar-conteudo-ia:', msg)
    return new Response(
      JSON.stringify({ error: msg, erroMsg: msg }),
      { status: 500, headers: CORS }
    )
  }
})
