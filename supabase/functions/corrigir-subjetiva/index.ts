import { serve } from "https://deno.land/std@0.168.0/http/server.ts"

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Content-Type': 'application/json',
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })

  try {
    const { enunciado, gabarito, criterios, pontos, resposta_aluno } = await req.json()

    const prompt = `Você é um professor corrigindo uma questão dissertativa de prova escolar.

Questão: ${enunciado}
Gabarito (resposta esperada): ${gabarito}
${criterios ? `Critérios de avaliação: ${criterios}` : ''}
Pontuação máxima: ${pontos} pontos

Resposta do aluno: ${resposta_aluno || '(em branco)'}

Avalie a resposta do aluno com rigor pedagógico e retorne APENAS um JSON com dois campos:
- "nota": número de 0 a ${pontos} (pode usar decimal como 2.5; 0 se em branco ou completamente errado)
- "feedback": comentário em português de até 2 linhas explicando a nota, o que acertou e o que faltou`

    const r = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${Deno.env.get('DEEPSEEK_API_KEY')}`,
      },
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages: [{ role: 'user', content: prompt }],
        response_format: { type: 'json_object' },
        temperature: 0.1,
        max_tokens: 200,
      }),
    })

    if (!r.ok) {
      const err = await r.text()
      throw new Error(`DeepSeek API error ${r.status}: ${err}`)
    }

    const data = await r.json()
    let result: { nota: number; feedback: string } = { nota: 0, feedback: 'Erro na correção automática.' }

    try {
      result = JSON.parse(data.choices[0].message.content)
    } catch {
      result = { nota: 0, feedback: 'Não foi possível processar a resposta da IA.' }
    }

    // clamp nota entre 0 e pontos
    result.nota = Math.min(Math.max(Number(result.nota) || 0, 0), Number(pontos))

    return new Response(JSON.stringify(result), { headers: CORS })
  } catch (e) {
    return new Response(
      JSON.stringify({ nota: 0, feedback: 'Erro interno na correção.', error: String(e) }),
      { status: 500, headers: CORS }
    )
  }
})
