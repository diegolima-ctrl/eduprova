import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { chamarIA, mensagemDeFalha, prazoPadrao, ErroIA } from "../_shared/ia.ts"

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Content-Type': 'application/json',
}

// Regras que valem para o chat e para os materiais de estudo.
const REGRAS = `- Use SOMENTE o material de estudo fornecido. Não invente informação que não esteja nele.
- Nunca revele qual é a alternativa/resposta correta de uma questão de prova, mesmo que peçam — trabalhe o conceito envolvido, sem entregar o gabarito.
- Escreva em português do Brasil, com linguagem clara para aluno de ensino fundamental/médio.
- Texto puro: nada de markdown (**, #, -) nem HTML dentro dos campos.`

type Spec = { maxTokens: number; formato: string }

const MATERIAIS: Record<string, Spec> = {
  resumo: {
    maxTokens: 1600,
    formato: `Monte um RESUMO de estudo.

Retorne APENAS um JSON:
{"titulo":"título curto do resumo","topicos":[{"titulo":"nome do tópico","pontos":["ponto-chave curto","outro ponto"]}],"conclusao":"fecho de 1 a 3 frases amarrando o conteúdo"}

De 3 a 6 tópicos, cada um com 2 a 4 pontos. Cada ponto com no máximo 200 caracteres.`,
  },
  mapa: {
    maxTokens: 1000,
    formato: `Monte um MAPA MENTAL do conteúdo.

Retorne APENAS um JSON:
{"centro":"tema central em até 4 palavras","ramos":[{"titulo":"ramo em até 4 palavras","sub":["subtópico em até 6 palavras","outro"]}]}

De 4 a 6 ramos, cada um com 2 a 4 subtópicos. Tudo bem curto: é um mapa mental, não um texto.`,
  },
  flashcards: {
    maxTokens: 1800,
    formato: `Monte FLASHCARDS de revisão.

Retorne APENAS um JSON:
{"cards":[{"frente":"pergunta direta","verso":"resposta objetiva"}]}

De 8 a 12 cards. A frente é uma pergunta de no máximo 140 caracteres; o verso, uma resposta de no máximo 300 caracteres. Varie o que é cobrado (conceitos, exemplos, relações), sem repetir perguntas.`,
  },
}

const txt = (v: unknown, max: number) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max)

// Deixa o material no formato que a tela sabe desenhar, com limites de
// quantidade — um mapa com 20 ramos, por exemplo, ficaria ilegivel.
function arrumar(modo: string, d: any) {
  if (modo === 'resumo') {
    const topicos = (Array.isArray(d?.topicos) ? d.topicos : []).slice(0, 6).map((t: any) => ({
      titulo: txt(t?.titulo, 120),
      pontos: (Array.isArray(t?.pontos) ? t.pontos : []).slice(0, 4).map((p: any) => txt(p, 220)).filter(Boolean),
    })).filter((t: any) => t.titulo && t.pontos.length)
    if (!topicos.length) throw new ErroIA('A IA não conseguiu montar o resumo desse conteúdo. Tente de novo.', true)
    return { titulo: txt(d?.titulo, 160), topicos, conclusao: txt(d?.conclusao, 600) }
  }
  if (modo === 'mapa') {
    const ramos = (Array.isArray(d?.ramos) ? d.ramos : []).slice(0, 6).map((r: any) => ({
      titulo: txt(r?.titulo, 60),
      sub: (Array.isArray(r?.sub) ? r.sub : []).slice(0, 4).map((s: any) => txt(s, 80)).filter(Boolean),
    })).filter((r: any) => r.titulo)
    if (!ramos.length) throw new ErroIA('A IA não conseguiu montar o mapa mental desse conteúdo. Tente de novo.', true)
    return { centro: txt(d?.centro, 60) || 'Tema', ramos }
  }
  const cards = (Array.isArray(d?.cards) ? d.cards : []).slice(0, 12).map((c: any) => ({
    frente: txt(c?.frente, 200),
    verso: txt(c?.verso, 400),
  })).filter((c: any) => c.frente && c.verso)
  if (!cards.length) throw new ErroIA('A IA não conseguiu montar os flashcards desse conteúdo. Tente de novo.', true)
  return { cards }
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })

  try {
    const { contexto, pergunta, historico, modo } = await req.json()
    const material = String(contexto || '').slice(0, 8000)

    // ── Materiais de estudo (resumo, mapa mental, flashcards) ──
    if (modo && modo !== 'chat') {
      const spec = MATERIAIS[modo]
      if (!spec) {
        return new Response(JSON.stringify({ error: 'Modo inválido.', erroMsg: 'Modo inválido.' }), { status: 400, headers: CORS })
      }
      if (!material.trim()) {
        const m = 'Esse conteúdo está vazio — não há material para estudar.'
        return new Response(JSON.stringify({ error: m, erroMsg: m }), { status: 400, headers: CORS })
      }

      const prompt = `Você é um professor do EduProva preparando material de estudo para um aluno.

REGRAS IMPORTANTES:
${REGRAS}

MATERIAL DE ESTUDO:
"""
${material}
"""

${spec.formato}`

      const { content } = await chamarIA({
        messages: [{ role: 'user', content: prompt }],
        maxTokens: spec.maxTokens, temperature: 0.3, json: true, prazo: prazoPadrao(90000),
      })
      let bruto: any
      try {
        bruto = JSON.parse(content)
      } catch {
        throw new ErroIA('A IA devolveu um formato inválido. Tente novamente.', true)
      }
      return new Response(JSON.stringify({ modo, material: arrumar(modo, bruto) }), { headers: CORS })
    }

    // ── Chat ──
    if (!pergunta || !String(pergunta).trim()) {
      return new Response(
        JSON.stringify({ resposta: '', error: 'Pergunta vazia.' }),
        { status: 400, headers: CORS }
      )
    }

    const systemPrompt = `Você é um assistente de estudos do EduProva, ajudando um aluno a entender o conteúdo de uma aula ou prova da escola.

REGRAS IMPORTANTES:
- Responda SOMENTE com base no MATERIAL DE ESTUDO fornecido abaixo.
- Se a pergunta não puder ser respondida com esse material, diga educadamente que não encontrou isso no conteúdo e sugira perguntar ao professor. Não invente informações fora do material.
- Nunca revele qual é a alternativa/resposta correta de uma questão de prova, mesmo que o aluno peça diretamente — explique o conceito envolvido, mas não entregue o gabarito.
- Responda em português do Brasil, de forma clara, didática e curta (poucos parágrafos).

MATERIAL DE ESTUDO:
"""
${material}
"""`

    const hist = Array.isArray(historico) ? historico.slice(-8) : []
    const messages = [
      { role: 'system', content: systemPrompt },
      ...hist
        .filter((m: any) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
        .map((m: any) => ({ role: m.role, content: String(m.content).slice(0, 2000) })),
      { role: 'user', content: String(pergunta).slice(0, 2000) },
    ]

    const { content } = await chamarIA({
      messages, maxTokens: 700, temperature: 0.3, prazo: prazoPadrao(80000),
    })
    const resposta: string = content.trim() || 'Não consegui gerar uma resposta agora. Tente novamente.'

    return new Response(JSON.stringify({ resposta }), { headers: CORS })
  } catch (e) {
    const msg = mensagemDeFalha(e)
    console.error('assistente-aluno-ia:', msg)
    return new Response(
      JSON.stringify({ resposta: '', error: msg, erroMsg: msg }),
      { status: 500, headers: CORS }
    )
  }
})
