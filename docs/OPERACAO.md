# Operação e validação

## Migração e continuidade

A implantação de 29/09/2026 substituiu SQLite por PostgreSQL em uma base então vazia. Esse registro é histórico; não há importação automática de SQLite. Se houver dados locais antigos, preserve o arquivo e sua chave antes da troca.

O código da ponte incorpora a funcionalidade de áudio do Cash (`8aa502a`). A ponte foi publicada no commit `9ddc456`, e o Hub foi publicado no Render com PostgreSQL em 29/09/2026. A comunicação assinada entre os serviços foi validada. O callback WhatsApp do app Meta foi transferido para o Hub e aceito pela verificação da Meta, mantendo `messages` na versão v25.0. O usuário posteriormente confirmou consultas e novos lançamentos pelo canal. O roteiro abaixo serve para novas implantações ou mudanças no ingresso; não representa testes repetidos a cada revisão documental.

1. Publique o código da ponte Cash mantendo o webhook atual e configure os conectores em ambiente de teste.
2. Valide com um número de teste: QR/vínculo Cash, consulta, áudio inicial, correção por novo áudio, rejeição de confirmação por voz/texto e por botão antigo, confirmação pelo botão revisado e reentrega sem duplicação; conecte Day/Google com contas próprias; teste desconexão e permissões.
3. Depois da validação, troque o callback Meta para `HUB_PUBLIC_URL/webhooks/whatsapp`. Um único serviço deve receber cada evento. O número e os vínculos Cash existentes são preservados.
4. Em rollback, volte o callback ao Cash. Day/Calendar ficam indisponíveis naquele canal, e o fluxo financeiro continua no backend anterior. Preserve o banco e a chave do Hub.

O pool mantém até 5 conexões por processo por padrão (`HUB_DATABASE_POOL_MAX`, entre 2 e 10), incluindo uma sessão reservada ao bloqueio do worker. Use conexão direta PostgreSQL, sem pooler em modo transaction. Durante um deploy, a nova versão recebe webhooks, mas espera o bloqueio da anterior antes de processar a fila. A perda dessa sessão encerra o processo. O encerramento normal espera a operação ativa e libera o banco. A retenção é executada a cada minuto.

O Hub não repete automaticamente uma operação interrompida nem um envio cujo resultado seja incerto. Registros `uncertain` exigem conferência operacional para evitar duplicar efeitos. Uma operação aceita remotamente antes de um timeout pode ter sido concluída. IDs e erros genéricos permitem diagnosticar sem imprimir credenciais. Mídias diferentes de áudio não são interpretadas. Notificações proativas seguem o fluxo de assinatura, agendamento e templates descrito em [Notificações](NOTIFICACOES.md). Confirmações de entrega não são sincronizadas de volta aos registros antigos do Cash.

## Validação

Os testes usam PostgreSQL real em schemas descartáveis de uma base local terminada em `_test`. A configuração é independente de `DATABASE_URL` e recusa hosts remotos. Para usar o ambiente de teste fornecido:

```powershell
docker compose -f compose.test.yaml up -d --wait
Copy-Item .env.test.example .env.test
npm run check
```

Se já houver um PostgreSQL local, configure `TEST_DATABASE_URL` em `.env.test` com uma base de teste existente. Nunca aponte testes para o Render. O build no Render compila e verifica tipos; os testes devem rodar localmente ou no CI.

`npm run check` testa assinatura, destino do webhook, fila, repetição, criptografia, isolamento por remetente, OAuth/PKCE, CSRF, confirmação final, renovação de tokens, consultas entre domínios, encaminhamento de áudio, indicador de digitação e ingressos HTTP reais com serviços externos simulados. O teste de integração `assistant-runtime` no Cash percorre os dois caminhos (webhook anterior e ponte Hub), incluindo correção por áudio e exatamente um lançamento após o botão revisado.

Os testes não equivalem à validação com credenciais Google/Meta/Supabase reais. A ativação exige configurar os serviços acima e executar o piloto antes de trocar o webhook de produção.

## Referências do protocolo

- [Google OAuth web server](https://developers.google.com/identity/protocols/oauth2/web-server)
- [Supabase OAuth server](https://supabase.com/docs/guides/auth/oauth-server/getting-started)
- [Supabase token security](https://supabase.com/docs/guides/auth/oauth-server/token-security)
- [OpenAI function calling](https://developers.openai.com/api/docs/guides/function-calling)
