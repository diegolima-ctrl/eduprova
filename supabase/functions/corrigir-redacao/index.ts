import { serve } from "https://deno.land/std@0.168.0/http/server.ts"

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Content-Type': 'application/json',
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })

  try {
    const { proposta, criterios, pontos, foto_url } = await req.json()

    const prompt = `Você é um professor corretor do ENEM avaliando uma redação dissertativo-argumentativa escrita à mão.

Proposta/Tema: ${proposta}
${criterios ? `Critérios adicionais: ${criterios}` : ''}
Pontuação máxima configurada: ${pontos} pontos

Leia a redação na imagem e avalie seguindo o modelo ENEM. Retorne APENAS um JSON com estes campos:
- "c1": Competência 1 - Domínio da norma culta da língua escrita (0, 40, 80, 120, 160 ou 200)
- "c2": Competência 2 - Compreensão da proposta e desenvolvimento do tema (0, 40, 80, 120, 160 ou 200)
- "c3": Competência 3 - Seleção e organização dos argumentos (0, 40, 80, 120, 160 ou 200)
- "c4": Competência 4 - Conhecimento dos mecanismos linguísticos de coesão (0, 40, 80, 120, 160 ou 200)
- "c5": Competência 5 - Elaboração de proposta de intervenção social (0, 40, 80, 120, 160 ou 200)
- "total": soma de c1+c2+c3+c4+c5 (número entre 0 e 1000)
- "feedback": comentário em português de até 4 linhas destacando pontos fortes e o que precisa melhorar`

    const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${Deno.env.get('GROQ_API_KEY')}`,
      },
      body: JSON.stringify({
        model: 'meta-llama/llama-4-scout-17b-16e-instruct',
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            { type: 'image_url', image_url: { url: foto_url } },
          ],
        }],
        response_format: { type: 'json_object' },
        temperature: 0.1,
        max_tokens: 400,
      }),
    })

    if (!r.ok) throw new Error(`Groq error ${r.status}: ${await r.text()}`)

    const data = await r.json()
    let result: { c1:number; c2:number; c3:number; c4:number; c5:number; total:number; feedback:string } = {
      c1:0,c2:0,c3:0,c4:0,c5:0,total:0,feedback:'Erro ao processar resposta da IA.'
    }

    try {
      result = JSON.parse(data.choices[0].message.content)
    } catch {
      result = { c1:0,c2:0,c3:0,c4:0,c5:0,total:0,feedback:'Não foi possível interpretar a resposta da IA.' }
    }

    // Clamp cada competência a múltiplos de 40 entre 0–200
    const clamp = (v: number) => Math.min(200, Math.max(0, Math.round(Number(v) / 40) * 40))
    result.c1 = clamp(result.c1 ?? 0)
    result.c2 = clamp(result.c2 ?? 0)
    result.c3 = clamp(result.c3 ?? 0)
    result.c4 = clamp(result.c4 ?? 0)
    result.c5 = clamp(result.c5 ?? 0)
    result.total = result.c1 + result.c2 + result.c3 + result.c4 + result.c5

    return new Response(JSON.stringify(result), { headers: CORS })
  } catch (e) {
    return new Response(
      JSON.stringify({ c1:0,c2:0,c3:0,c4:0,c5:0,total:0,feedback:'Erro interno na correção.',error:String(e) }),
      { status: 500, headers: CORS }
    )
  }
})
