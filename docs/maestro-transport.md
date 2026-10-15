# Transporte e estado Maestro (E04-09/10, implementação local)

A entrada adicional `dooers-agents-client/maestro` exporta `MaestroClient`, `MaestroProvider`, `MaestroClientError`, tipos e os hooks `useMaestroClient`, `useMaestroConnection`, `useMaestroMessage` e `useMaestroPublications`. A versão do pacote continua `0.17.1`; esta implementação local ainda não foi publicada. `dooers-agents-client` e `AgentProvider` mantêm o comportamento legado.

```tsx
import { MaestroProvider, useMaestroMessage } from 'dooers-agents-client/maestro'

// Identidade/escopo e modo vêm da sessão e descoberta confiável do core.
// Não escolher Maestro pelo hostname ou pela versão de um agente.
<MaestroProvider config={{
  mode: 'maestro',
  endpoint: 'https://maestro.example',
  apiPrefix: '/api/v1',
  scope: { principalId: coreUserId, organizationId, workspaceId },
  authToken: ({ signal, scope }) => obtainCoreMaestroToken(scope, signal),
  transport: 'websocket',
}}>
  <Conversation />
</MaestroProvider>
```

`endpoint` recebe somente a origem HTTP(S), sem credenciais, query, fragmento ou prefixo de path. HTTP usa `apiPrefix`, enquanto WS usa exatamente `/ws` na raiz. HTTPS/WSS são padrão obrigatório; loopback HTTP/WS exige `allowInsecureLocalhost: true`. A configuração não pede `agentId` nem acrescenta `mode` ao frame de connect. Tokens não aparecem em URL ou logs. Os limites de request, heartbeat, reconexão, bytes de resposta e publicações em memória são configuráveis com máximos explícitos.

O token humano deve corresponder a `scope` em todos os transportes. O filtro local inspeciona header/claims canônicos, tipo humano, subject/user, organização/workspace e prazo; **não verifica assinatura, sessão, membership ou permissões**. A autenticação remota por `connect`/`auth.refresh` ou `GET /capabilities` permanece obrigatória. Tokens técnicos/de agente são recusados nesse cliente humano. O resolver recebe `AbortSignal`, tem timeout e é chamado por sessão/renovação; não há cache global de credencial.

No modo WS, operações só são liberadas após ACK válido com `history_authority=maestro`, protocolo 1 e capabilities anunciadas. No modo HTTP explícito, `connect()` consulta `/capabilities`. Versão do pacote/servidor não habilita recurso. Ausência de capability gera `UNSUPPORTED_CAPABILITY`, sem fallback para agente. O cliente oferece publicação textual, listagem/detalhe de threads, página de histórico e comandos básicos de subscribe/unsubscribe. Anexos e ações de execução/interação não estão implementados neste card.

## Intenção, confirmação e retry

```ts
const intent = client.prepareMessage({ threadId, content: [{ type: 'text', text: 'Olá' }] })
// Persistir a chave/intent no estado da aplicação, se a aplicação precisar
// recuperar a mesma operação após desmontar o provider (não há fila offline).
try {
  const receipt = await client.send(intent)
  // Ledger já reconciliado: threadId, eventId, cursor, clientEventId e evento canônico.
} catch (error) {
  // unknown significa commit incerto; conservar intent/clientEventId.
  // Uma ação explícita pode chamar client.retry(threadId, intent.clientEventId,
  // { transport: 'http' }) após reautenticar/conectar.
}
```

`prepareMessage()` cria a chave antes de qualquer I/O e retorna conteúdo validado e imutável. `send()` aceita chave fornecida; `retry()` conserva corpo/chave exatos. UUIDs de organização/workspace/thread/mentions/participantes nas opções são normalizados para minúsculas antes da intenção; principal humano e client_event_id permanecem opacos, preservando caixa. Defaults de arrays opcionais normalizam para `[]`. A tentativa concorrente idêntica compartilha a mesma promise; conteúdo diferente sob a chave conhecida falha com `IDEMPOTENCY_CONFLICT`. O retry de resultado persistido já conhecido retorna o recibo em memória sem novo envio. HTTP envia a mesma chave em `Idempotency-Key` e `client_event_id`.

O ledger de publicações separa `pending`, `persisted`, `rejected` e `unknown`. ACK de commit valida thread, autor, chave, conteúdo e cursor, incorpora o evento, atualiza o comando e só então resolve `send()`. `event.append` nunca resolve uma promise de envio; ACK/append duplicados em qualquer ordem geram um evento. Igualdade de texto/timestamp não é identidade. Um evento de outro autor com a mesma chave não confirma a intenção local. Sequências continuam strings, inclusive acima de 53 bits.

Negação canônica conclusiva de validação, autorização ou conflito significa `rejected`. Erros técnicos de dependência/core e respostas 5xx continuam `unknown`, porque não comprovam ausência de commit. Queda, timeout, resposta inválida ou desconexão após envio significa `unknown`; nenhuma dessas condições gera nova chave ou retry automático. A ausência de ACK não prova rollback. O SDK bloqueia novos envios desconectados e não promete fila offline durável. Retém até `maxPublications` (padrão 1000), sem descartar automaticamente intenções incertas. `reset()`/`dispose()` apagam esse estado; se necessário, a aplicação mantém a intenção sob sua própria política de privacidade para repetir a chave após reconciliação de acesso.

## Sessão e provider

`refreshAuth()` exige ACK remoto antes de usar token novo e bloqueia novos comandos durante o refresh. Credenciais distintas recebidas enquanto um refresh está em voo são serializadas, cada qual aguardando seu próprio ACK; falha mantém acesso fechado. O provider reautentica quando `authToken` muda. Recomendação: manter a função resolver estável entre renders, renovando seu resultado pelo callback `onAuthRequired` ou por `refreshAuth()` explícito.

Heartbeat correlaciona nonce; perda de confirmação encerra o socket. Reconexão usa backoff/jitter e número máximo configurável, obtém credencial novamente e refaz handshake. **Não republica intenções.** Restaura apenas assinaturas com referências ativas, após novo handshake aceito, a partir do último cursor cuja continuidade foi comprovada. Timeout/desmontagem do cliente não envia cancelamento de execução ao Maestro.

Troca de principal/org/workspace/origem/transporte cria um cliente vazio antes de renderizar os novos filhos, encerra o anterior e cancela suas requisições. `reset()` limpa conteúdo/intenções da instância anterior; respostas tardias não repovoam o estado. Expiração/rejeição de autorização limpa conteúdo em memória e sinaliza `onAuthRequired`. Não há persistência em localStorage/sessionStorage. Providers separados não compartilham tokens, ledger ou socket. React StrictMode setup/cleanup/setup é coberto.

É possível aninhar `MaestroProvider` dentro de `AgentProvider`: `useSettings` e `useAnalytics` continuam usando o contexto legado e sua conexão/credencial particular. O novo cliente não expõe esses métodos nem os encaminha ao WS Maestro. A aplicação mantém explicitamente ambos os lifecycles quando precisa dos recursos privados do agente.

## Store, hooks e retomada

O cliente possui `store: MaestroStore`, exclusivo daquela identidade/organização/workspace e autoridade Maestro. `store.getSnapshot()` retorna `scope` e um índice de threads; cada thread contém `eventsById`/`eventIds` em ordem numérica exata, índices separados de participantes, entregas e execuções, `optimisticByKey` e `commandsByKey`. Não há armazenamento local persistente nem store global compartilhado entre providers. `getSnapshot`/`subscribe` seguem o contrato de `useSyncExternalStore`.

```tsx
import { useMaestroThread, useMaestroExecutions } from 'dooers-agents-client/maestro'

function Conversation({ threadId }: { threadId: string }) {
  const { state, loadBefore, retryReplay } = useMaestroThread(threadId)
  const { deliveries, executions, hasPendingWork, waitingForInput } = useMaestroExecutions(threadId)
  // state.eventIds.map(id => state.eventsById[id]) conserva autoria e sequência.
  // item.known=false identifica um envelope durável futuro não interpretado.
  // Tratar state.phase=failed com retryReplay() explícito; mostrar state.error.
  // loadBefore() usa o cursor histórico próprio e faz uma página por chamada.
  return null
}
```

`useMaestroThreads()` observa o mapa de threads já lidas, sem disparar listagem ou criar conversas. `useMaestroThread(id)`, `useMaestroParticipants(id)` e `useMaestroExecutions(id)` retêm uma referência cada. Fora do React, `const release = client.retainThread(id)` oferece o mesmo lifecycle. A primeira referência abre uma assinatura; a última chama unsubscribe. `release` é idempotente. Remount conserva o histórico e cursor seguro no mesmo cliente. ACK antigo de uma referência já solta não pode anexar seus frames à referência nova, mesmo para o mesmo threadId. Troca de escopo/provider cancela e limpa a instância anterior.

O snapshot fornece metadados/permissões atuais; replay não regride o estado de participantes de um snapshot mais novo. Projeções duráveis de delivery/execução só são aplicadas após cobertura do intervalo. `waiting_broker`, `pending`, `running` e `retry_wait` geram `hasPendingWork`; `waiting_input` é `waitingForInput` e suspende a execução anterior que ainda estivesse projetada como running. Estado terminal individual e várias entregas ficam disponíveis sem deduzir sucesso pelo primeiro texto. O campo `thread` conserva o DTO de metadados mais recente; use `participantsById`/hook para a projeção atual dos participantes.

`appliedSequence`, `receivedSequence`, `resumeCursor` e `beforeCursor` são distintos. Um ACK prova apenas aquele evento; não cobre o intervalo anterior e não avança `resumeCursor`. Append/replay são deduplicados por eventId e sequence; identidades contraditórias falham explicitamente. Só o intervalo contíguo pode aplicar um checkpoint, e um append duplicado antigo não faz o cursor regredir. `caught_up` precisa cobrir o watermark anunciado. `BigInt` é usado internamente na soma; valores públicos continuam strings JSON exatas.

O servidor envia as páginas de snapshot/replay até caught_up; o SDK consome todas, inclusive acima de 500 eventos e snapshot inicial só de metadados. O leitor derivado dos contratos aceita eventos duráveis futuros com envelope v1 validado como `known:false`, retém sua posição e conteúdo genérico, e não interpreta sua payload nem habilita capacidades. Frames desconhecidos continuam ignorados; eventos conhecidos inválidos fecham o transporte. `getHistory()` preserva a API estrita de E04-09; `getHistoryPage()` acrescenta leitura compatível de envelopes futuros.

`loadBefore()` usa cursor próprio, compartilha a mesma consulta em voo, retorna uma página cronológica e conserva a posição live. Seu cursor não avança replay. Resposta histórica posterior a release/revocation/reset é descartada; nova consulta exige referência ativa. Paginação antiga não regride projeções atuais. Uma página que anuncia has_more sem progresso é erro explícito.

Gap, overflow ou resync de replay cancelam aquela assinatura e tentam recuperar pelo último cursor seguro com backoff exponencial limitado. O padrão é três tentativas consecutivas, 250 ms inicial e teto de 30 s; um caught_up válido reinicia o orçamento de recuperação. Após esgotar, a thread fica `failed`, com erro e retry explícito (`retryReplay`). Não há publicação automática, nem cancelamento de execução por reconexão.

`resync.required` com action `snapshot` (por exemplo cursor expirado/epoch alterado) invalida a continuidade anterior: remove eventos, projeções, metadados e cursores históricos/live da thread e reconstrói pelo snapshot autorizado. Comandos pending/unknown e suas intenções permanecem separados; resultados persisted antigos não repovoam o store por atualização do ledger de outra thread. Leituras/ACKs que atravessam essa troca são barrados por revisão da thread; um envio com ACK tardio permanece unknown para retry explícito da mesma chave. Replay normal e reconnect dentro da mesma continuidade preservam páginas antigas. O ledger E04-09 conserva recibos próprios já confirmados como histórico da operação; eles não provam a continuidade recém-reconstruída.

Revogação de assinatura apaga conteúdo, projeções, comandos e intenções daquela thread, barra ACK em voo e impede retry local; outras threads permanecem independentes. Expiração de sessão limpa todo conteúdo do escopo antes de obter nova credencial. Permissões e estado exibidos são projeções consultivas: autorização remota continua obrigatória para cada operação.

Limites padrão: `maxBufferedEvents=1000`, `maxEventsPerThread=20000`, `maxThreads=100`, além dos limites de bytes/transporte e `maxPublications=1000` de E04-09. Máximos configuráveis são respectivamente 10000, 100000 e 1000 threads. Não há descarte silencioso de evento confirmado/intenção incerta nem LRU: exceder capacidade torna o problema explícito; a aplicação deve encerrar/limpar o escopo com `reset()` quando puder descartar seu estado ou usar limites adequados. Histórico normalizado é em memória, sem promessa de offline/resumo após recarregar a página.

## Limites e handoff para E04-11

As capabilities continuam vindo do handshake/descoberta remotos: o SDK não fabrica anúncio de suporte. Não implementados nesta fatia: UI web, comandos de execução/cancelamento/interações, anexos e reconciliação remota de intenções após reload. São cards posteriores. O store já conserva seus eventos conhecidos e correlações canônicas quando recebidos; isso não disponibiliza comandos ou serviços ainda não ligados.

O pacote foi exercitado com fixtures, HTTP loopback de teste e instalação real ESM/CJS/types/browser sob React 18.3.1 e 19.2.4 (SSR de hooks); lifecycle/montagem React usam 19.2.4. A integração com core/PostgreSQL/broker/gateways reais é **E04-11**. Servidor fixture/filtro local de JWT não demonstra autorização real, commit no banco ou disponibilidade de produção.

## Comandos de verificação

- `npm test`: contratos congelados, regressão legada, transporte, filtro de identidade, provider, store, refs/recovery e hooks.
- `npx tsc --noEmit` e `npx biome check src/maestro`.
- `npm run test:maestro:package`: conformidade do artefato instalado herdada de E04-01.
- `npm run test:maestro:transport-package`: build, npm pack, instalação offline temporária em duas versões React, HTTP loopback real do pacote, store com 603 eventos/gap/evento futuro, SSR dos hooks, types e bundle browser. Nenhum pacote é publicado.

## Streams provisórios (E09-04)

`useMaestroStreams(threadId)` compartilha a assinatura existente e retorna `{ streams, resyncRequired }`. Cada stream tem `threadId`, `executionId`, `outputId`, `participantId`, `text`, `chunkCount`, `byteLength` e `ephemeral: true`; `maestroStreamKey(executionId, outputId)` indexa `state.streamsByKey`. O consumidor resolve o nome pelo participante canônico. Deltas nunca entram em `eventsById`, receipts ou cursor; final canônico substitui o provisório e conserva a ordenação/replay já existentes. Não há persistência, ledger de efeitos ou UI adicional.

A projeção exige `stream.delta` negociado, assinatura atual, thread live/active, participante agente ativo e execução **conhecida e running**, ligada ao mesmo participante. Um chunk que antecede `execution.started` é descartado; perder parcial não perde o final. Capability ausente não ativa suporte. Campos adicionais de frames conhecidos são removidos pelo parser receive-side congelado; eventos futuros desconhecidos não geram projeção incremental. Token, scopes/fence e taxa de ingresso continuam autoridades do backend, não são inferidos do payload efêmero.

Política local E09-01 adotada sem alteração: 16 KiB UTF-8 por delta (também 16.384 unidades UTF-16 do schema), 64 KiB e 256 chunks por output, 16 outputs e 256 KiB agregados por sessão/store, até 128 marcadores de espera/final/terminal. Duplicata idêntica não altera o snapshot; conflito, gap, reset, autoria divergente ou excesso descartam o output e esperam o final. `byteLength` mede **conteúdo lógico UTF-8**, não heap: chunks, texto concatenado, strings UTF-16, maps e snapshots coexistem. Os limites são locais, sem promessa de memória física/SLO de produção. Nenhum limite provisório restringe o tamanho do final durável.

Reconexão, resync, refresh de credencial e saída da thread limpam parciais mantendo tombstones; terminalização encerra apenas a execução correspondente; remoção encerra o participante; archive/revogação encerram a thread. Replay recupera somente final/status canônico. Um final recebido antes do delta ou pela história também fecha o output; um receipt não avança cursor. A proteção por geração descarta callbacks de sockets antigos. O wire v1 não tem subscription_id nos frames stream: um output desconhecido atrasado no mesmo socket após nova assinatura não pode ser distinguido só pelo frame. O relay deve revalidar a assinatura atual; o cliente ainda exige execução ativa conhecida. Nenhum pin/wire foi alterado.

Esgotar 128 controles limpa todos os parciais e fixa `resyncRequired=true`, sem evicção de tombstones, loop de reconexão, cancelamento ou alteração do histórico. Reconnect/retry de uma thread não liberam esse latch: a aplicação pode seguir recebendo finais normalmente e, quando puder descartar o estado privado, usar `client.reset()` e uma nova conexão/assinatura autorizada. Disposição/troca de escopo limpa controles. Mantê-los entre reconexões é deliberadamente conservador: sessões longas podem perder incrementais antes de perder qualquer final.

O corpus E09-01 foi copiado integralmente para `tests/fixtures/maestro-streaming-scenarios.json`. 31 cenários verificam hashes/contagens provisórios no projector real; stale-fence, unauthorized e request-rate pertencem ao ingresso servidor; canonical conflict é exercitado no store canônico. Não se apresenta isso como prova de autorização remota, rate distribuído, cancelamento remoto ou convergência real entre réplicas (E09-08/10).
