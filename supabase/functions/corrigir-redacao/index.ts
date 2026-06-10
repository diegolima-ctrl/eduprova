import { serve } from "https://deno.land/std@0.168.0/http/server.ts"

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Content-Type': 'application/json',
}

async function groqChat(model: string, messages: unknown[], maxTokens = 1000) {
  const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${Deno.env.get('GROQ_API_KEY')}`,
    },
    body: JSON.stringify({ model, messages, temperature: 0.1, max_tokens: maxTokens }),
  })
  if (!r.ok) throw new Error(`Groq error ${r.status}: ${await r.text()}`)
  return r.json()
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })

  try {
    const { proposta, criterios, pontos, foto_url } = await req.json()

    // Passo 1: transcrever o texto manuscrito da foto
    const transcData = await groqChat(
      'meta-llama/llama-4-scout-17b-16e-instruct',
      [{
        role: 'user',
        content: [
          {
            type: 'text',
            text: 'Transcreva fielmente o texto manuscrito nesta imagem. Copie exatamente as palavras, parágrafos e pontuação como estão escritos, incluindo erros ortográficos e gramaticais. Retorne apenas o texto transcrito, sem comentários ou explicações.',
          },
          { type: 'image_url', image_url: { url: foto_url } },
        ],
      }],
      900,
    )

    const transcricao: string = transcData.choices?.[0]?.message?.content ?? ''

    if (!transcricao.trim()) {
      return new Response(
        JSON.stringify({ c1:0,c2:0,c3:0,c4:0,c5:0,total:0,feedback:'Não foi possível ler o texto da redação na imagem enviada. Verifique se a foto está nítida e bem iluminada.', transcricao:'' }),
        { headers: CORS },
      )
    }

    // Passo 2: avaliar a transcrição com descritores detalhados do ENEM
    const evalPrompt = `Você é um avaliador oficial do ENEM corrigindo uma redação dissertativo-argumentativa.

PROPOSTA/TEMA: ${proposta}
${criterios ? `CRITÉRIOS ADICIONAIS DO PROFESSOR: ${criterios}` : ''}
PONTUAÇÃO MÁXIMA: ${pontos} pontos

TEXTO DA REDAÇÃO:
"""
${transcricao}
"""

Avalie cada competência com base nos descritores abaixo. Use SOMENTE os valores 0, 40, 80, 120, 160 ou 200.

C1 – DOMÍNIO DA NORMA CULTA DA LÍNGUA ESCRITA:
• 200 = Mínimos desvios gramaticais e ortográficos; excelente domínio da escrita formal
• 160 = Poucos desvios; bom domínio da escrita formal
• 120 = Alguns desvios; domínio mediano
• 80 = Muitos desvios gramaticais, ortográficos ou de acentuação; domínio insuficiente
• 40 = Desvios muito frequentes e graves; domínio precário
• 0 = Desconhecimento da norma culta; texto incompreensível por desvios

C2 – COMPREENSÃO DA PROPOSTA E DESENVOLVIMENTO DO TEMA:
• 200 = Tema desenvolvido com argumentação consistente e repertório sociocultural produtivo; excelente estrutura dissertativo-argumentativa
• 160 = Argumentação consistente sem repertório produtivo, ou bom uso de repertório com estrutura boa
• 120 = Argumentação previsível ou repertório superficial; domínio mediano da estrutura
• 80 = Cópia dos textos motivadores, tangenciamento do tema ou domínio insuficiente da estrutura
• 40 = Domínio precário do tipo textual; sem desenvolvimento coerente
• 0 = Fuga ao tema ou ausência de estrutura dissertativo-argumentativa

C3 – SELEÇÃO E ORGANIZAÇÃO DOS ARGUMENTOS:
• 200 = Argumentos selecionados e organizados com autoria, coerência e defesa clara de um ponto de vista
• 160 = Argumentos organizados com indícios de autoria e coerência
• 120 = Argumentos organizados mas limitados ou previsíveis
• 80 = Argumentos desorganizados, repetitivos ou contraditórios
• 40 = Argumentos pouco relacionados ao tema ou incoerentes
• 0 = Sem argumentos relevantes

C4 – MECANISMOS LINGUÍSTICOS DE COESÃO TEXTUAL:
• 200 = Excelente articulação entre períodos e parágrafos; uso diversificado e adequado de conectivos
• 160 = Boa articulação; poucas inadequações; repertório diversificado de recursos coesivos
• 120 = Articulação mediana com inadequações frequentes; repertório limitado de recursos coesivos
• 80 = Muitas inadequações na articulação; uso repetitivo ou equivocado de conectivos
• 40 = Articulação precária; justaposição de frases sem conexão
• 0 = Ausência de articulação; texto fragmentado

C5 – PROPOSTA DE INTERVENÇÃO SOCIAL:
• 200 = Proposta detalhada e bem articulada: apresenta agente, ação, meio/modo, finalidade e efeito; relacionada ao tema e à discussão desenvolvida
• 160 = Proposta bem elaborada com a maioria dos elementos (agente, ação, finalidade); articulada ao texto
• 120 = Proposta presente e relacionada ao tema, mas com elementos incompletos ou pouco articulada à discussão
• 80 = Proposta genérica, insuficiente ou não articulada ao tema
• 40 = Proposta precária; apenas menção vaga de solução
• 0 = Ausência de proposta de intervenção

Retorne APENAS um objeto JSON sem markdown, sem blocos de código:
{"c1":<valor>,"c2":<valor>,"c3":<valor>,"c4":<valor>,"c5":<valor>,"total":<soma>,"feedback":"<comentário em português de 4 a 6 linhas: destaque pontos fortes, aponte o que precisa melhorar em cada competência com nota baixa, e oriente sobre a proposta de intervenção se necessário>"}`

    const evalData = await groqChat(
      'llama-3.3-70b-versatile',
      [{ role: 'user', content: evalPrompt }],
      700,
    )

    const raw: string = evalData.choices?.[0]?.message?.content ?? ''

    let result: { c1:number; c2:number; c3:number; c4:number; c5:number; total:number; feedback:string; transcricao:string } = {
      c1:0, c2:0, c3:0, c4:0, c5:0, total:0,
      feedback: 'Não foi possível interpretar a resposta da IA.',
      transcricao: '',
    }

    try {
      const match = raw.match(/\{[\s\S]*\}/)
      if (match) {
        result = { ...JSON.parse(match[0]), transcricao: transcricao.slice(0, 500) }
      } else {
        throw new Error('JSON não encontrado na resposta')
      }
    } catch {
      result = { c1:0, c2:0, c3:0, c4:0, c5:0, total:0, feedback:'Resposta da IA em formato inesperado.', transcricao }
    }

    // Garante múltiplos de 40 entre 0 e 200
    const clamp = (v: number) => Math.min(200, Math.max(0, Math.round(Number(v) / 40) * 40))
    result.c1 = clamp(result.c1 ?? 0)
    result.c2 = clamp(result.c2 ?? 0)
    result.c3 = clamp(result.c3 ?? 0)
    result.c4 = clamp(result.c4 ?? 0)
    result.c5 = clamp(result.c5 ?? 0)
    result.total = result.c1 + result.c2 + result.c3 + result.c4 + result.c5

    return new Response(JSON.stringify(result), { headers: CORS })
  } catch (e) {
    console.error('corrigir-redacao error:', e)
    return new Response(
      JSON.stringify({ c1:0,c2:0,c3:0,c4:0,c5:0,total:0,feedback:'Erro interno na correção.',error:String(e) }),
      { status: 500, headers: CORS },
    )
  }
})
