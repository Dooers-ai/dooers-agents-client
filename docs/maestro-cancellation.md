# Interrupção explícita no Maestro

`client.cancelExecution({ threadId, executionId })` solicita somente a execução indicada. `client.stopRoot({ threadId, rootEventId })` interrompe a cadeia causal. Ambos exigem a capability negociada `executions.cancel`; o servidor reautoriza o ator e o alvo. Fechar conexão/provider nunca emite esses comandos.

O SDK cria uma chave antes de I/O, reutiliza a mesma intenção por alvo e compartilha a Promise de chamadas concorrentes. `idempotencyKey` e `reasonCode` podem ser fornecidos explicitamente; mudar um deles em uma intenção existente é conflito. Retry explícito admite `{ transport: 'http' | 'websocket' }` e conserva alvo/chave/motivo. Não existe fila offline nem retry automático de cancelamento.

`useMaestroControls()`/`client.controls.getSnapshot()` expõem recibos privados separados de mensagens/execuções: `pending`, `requested`, `unconfirmed`, `unknown`, `rejected`, `observed`. A Promise resolve com ACK aceito, nunca prova cancelamento terminal. Somente estado/evento canônico recebido por replay confirma `observed`, com `outcome` original (`canceled`, `completed`, `failed`, `timed_out`, `suspended` ou `stopped`). Uma conclusão normal que venceu a corrida permanece normal.

Após 30 segundos sem confirmação canônica, `requested` vira `unconfirmed`; o consumidor pode chamar `client.retryReplay(threadId)` ou repetir a mesma intenção. Não há polling ilimitado. Disconnect encerra timers e impede disparo de comandos ainda enfileirados; reset/revogação apagam o estado privado. Os recibos são limitados por `maxPublications` (1.000 por padrão), sem evicção silenciosa de intenções incertas.

Mensagens e ferramentas já efetivadas permanecem. Estes comandos não desfazem ações externas. A projeção incremental continua efêmera e só o estado canônico encerra a execução visual.


### Permissão consultiva e atualização de alvos

O snapshot vazio pode trazer `permissions.cancel=false`. Eventos canônicos que alteram raízes, execuções ou membership solicitam uma nova leitura de `/threads/:id`, somente em subscriptions retidas e conectadas. Um burst é coalescido; eventos durante a leitura pedem no máximo uma próxima leitura. Não há polling ou retry automático por falha HTTP. Durante a consulta, cancel permanece falso; somente a resposta atual do servidor pode habilitá-lo novamente. Release, revogação, resync e reconexão descartam respostas da geração anterior. Respostas na mesma sequência podem atualizar permissões sem reconstruir o histórico.

A permissão é consultiva para a thread. Cada execução/raiz continua exigindo autorização do recurso real no comando; um `true` não autoriza todos os alvos da thread. O servidor seleciona a raiz elegível ao caller antes de limitar o probe, incluindo autor humano não owner.
