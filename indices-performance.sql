-- EduProva — índices para as consultas do aluno
-- Rode no SQL Editor do Supabase (uma vez). Tudo é IF NOT EXISTS: pode rodar de novo sem risco.
--
-- Contexto: cada tela do aluno agora filtra no servidor (turma dele / respostas dele).
-- Sem estes índices o Postgres varre a tabela inteira em cada filtro — o que,
-- com a turma toda entrando junta, gera "canceling statement due to statement timeout".

-- ── Filtros por aluno ─────────────────────────────────────────────────────────
create index if not exists idx_respostas_aluno_ra            on public.respostas (aluno_ra);
create index if not exists idx_respostas_prova_id            on public.respostas (prova_id);
create index if not exists idx_respostas_ex_aluno_ra         on public.respostas_exercicios (aluno_ra);
create index if not exists idx_respostas_ex_exercicio_id     on public.respostas_exercicios (exercicio_id);
create index if not exists idx_progresso_aluno_ra            on public.progresso_trilha (aluno_ra);
create index if not exists idx_progresso_trilha_id           on public.progresso_trilha (trilha_id);
create index if not exists idx_frequencia_aluno_data         on public.frequencia (aluno_ra, data);
create index if not exists idx_exercicios_aula_id            on public.exercicios (aula_id);

-- ── Login do aluno ────────────────────────────────────────────────────────────
-- (se aluno_id já for chave/única, este índice apenas não será criado por já existir outro igual —
--  o IF NOT EXISTS confere só o NOME, então índice repetido em tabela pequena não pesa)
create index if not exists idx_alunos_aluno_id               on public.alunos (aluno_id);
create index if not exists idx_alunos_turma                  on public.alunos (turma);

-- ── Filtro por turma (coluna jsonb turmas, operador @>) ───────────────────────
create index if not exists idx_aulas_turmas_gin              on public.aulas      using gin (turmas jsonb_path_ops);
create index if not exists idx_provas_turmas_gin             on public.provas     using gin (turmas jsonb_path_ops);
create index if not exists idx_trilhas_turmas_gin            on public.trilhas    using gin (turmas jsonb_path_ops);
create index if not exists idx_exercicios_turmas_gin         on public.exercicios using gin (turmas jsonb_path_ops);

-- Atualiza as estatísticas para o planejador usar os índices novos de imediato.
analyze public.respostas;
analyze public.respostas_exercicios;
analyze public.progresso_trilha;
analyze public.frequencia;
analyze public.alunos;
analyze public.aulas;
analyze public.provas;
analyze public.trilhas;
analyze public.exercicios;
