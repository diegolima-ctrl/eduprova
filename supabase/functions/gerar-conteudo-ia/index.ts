import { serve } from "https://deno.land/std@0.168.0/http/server.ts"

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Content-Type': 'application/json',
}

async function deepseekJSON(prompt: string, maxTokens: number) {
  const cappedTokens = Math.min(maxTokens, 4000)
  const ctrl = new AbortController()
  const timeout = setTimeout(() => ctrl.abort(), 50000)
  let r: Response
  try {
    r = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      signal: ctrl.signal,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${Deno.env.get('DEEPSEEK_API_KEY')}`,
      },
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages: [{ role: 'user', content: prompt }],
        response_format: { type: 'json_object' },
        temperature: 0.5,
        max_tokens: cappedTokens,
      }),
    })
  } catch (e) {
    if ((e as Error)?.name === 'AbortError') {
      throw new Error('A IA demorou demais para responder. Tente novamente com menos questões.')
    }
    throw e
  } finally {
    clearTimeout(timeout)
  }
  if (!r.ok) {
    const err = await r.text()
    throw new Error(`DeepSeek API error ${r.status}: ${err.slice(0, 500)}`)
  }
  const data = await r.json()
  const content = data.choices?.[0]?.message?.content
  if (!content) throw new Error('A IA não retornou conteúdo. Tente novamente.')
  try {
    return JSON.parse(content)
  } catch {
    throw new Error('A IA retornou um formato inválido. Tente novamente.')
  }
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

  try {
    const { tipo, disciplina, tema, nivel, quantidade, tipoQuestao, contextoAulas, contextoAula } = await req.json()

    if (!disciplina || !tema) {
      return new Response(JSON.stringify({ error: 'Preencha disciplina e tema.' }), { status: 400, headers: CORS })
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

      const result = await deepseekJSON(prompt, 2500)
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

      const prompt = `Você é um professor brasileiro elaborando uma prova/avaliação.

${contextoBloco}Disciplina: ${disciplina}
Tema: ${tema}
Nível de dificuldade: ${nivelTxt}
Quantidade de questões: ${qtd}
Instrução sobre os tipos de questão: ${instrucaoTipo}

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
Gere exatamente ${qtd} questão(ões), seguindo a instrução sobre os tipos.`

      const result = await deepseekJSON(prompt, 800 * qtd + 500)
      const questoesRaw = Array.isArray(result?.questoes) ? result.questoes.slice(0, qtd) : []
      const questoes = questoesRaw.map(clampQuestao)

      return new Response(JSON.stringify({
        tipo: 'prova',
        titulo: String(result?.titulo || tema).slice(0, 200),
        disciplina: String(result?.disciplina || disciplina).slice(0, 100),
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

      const prompt = `Você é um professor brasileiro criando um exercício de fixação de múltipla escolha para os alunos praticarem o conteúdo de uma aula específica.

${contextoBloco}Disciplina: ${disciplina}
Aula: ${tema}
Nível de dificuldade: ${nivelTxt}

Gere exatamente ${qtd} questões de múltipla escolha (5 alternativas cada, uma correta), testando a compreensão do conteúdo acima.

Retorne APENAS um JSON no formato:
{
  "titulo": "título curto para o exercício (ex: Exercícios de Fixação — <tema da aula>)",
  "questoes": [{"tipo":"multipla","enunciado":"...","opcoes":["...","...","...","...","..."],"correta":0}]
}`

      const result = await deepseekJSON(prompt, 800 * qtd + 300)
      const questoesRaw = Array.isArray(result?.questoes) ? result.questoes.slice(0, qtd) : []
      const questoes = questoesRaw.map(clampQuestao).map((q: any) => ({ ...q, tipo: 'multipla' }))

      return new Response(JSON.stringify({
        tipo: 'exercicio',
        titulo: String(result?.titulo || `Exercícios de Fixação — ${tema}`).slice(0, 200),
        questoes,
      }), { headers: CORS })
    }

    return new Response(JSON.stringify({ error: 'Tipo inválido. Use "aula", "prova" ou "exercicio".' }), { status: 400, headers: CORS })
  } catch (e) {
    return new Response(
      JSON.stringify({ error: String(e), erroMsg: 'Erro ao gerar conteúdo com IA.' }),
      { status: 500, headers: CORS }
    )
  }
})
