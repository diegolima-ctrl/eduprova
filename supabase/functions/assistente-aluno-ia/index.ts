import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { deepseekChat, mensagemDeFalha, prazoPadrao } from "../_shared/deepseek.ts"

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Content-Type': 'application/json',
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })

  try {
    const { contexto, pergunta, historico } = await req.json()

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
${String(contexto || '').slice(0, 8000)}
"""`

    const hist = Array.isArray(historico) ? historico.slice(-8) : []
    const messages = [
      { role: 'system', content: systemPrompt },
      ...hist
        .filter((m: any) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
        .map((m: any) => ({ role: m.role, content: String(m.content).slice(0, 2000) })),
      { role: 'user', content: String(pergunta).slice(0, 2000) },
    ]

    const { content } = await deepseekChat({
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
