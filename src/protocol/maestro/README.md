# Contratos Maestro v1 no SDK cliente

Entrega E04-01. O subpath `dooers-agents-client/maestro/contracts` oferece schemas de conformidade, tipos wire e conversores públicos, sem transporte, store ou hooks Maestro. O entrypoint legado permanece intacto. A versão do pacote continua `0.17.1`; esta árvore local não foi publicada e não anuncia suporte Maestro integrado.

`vendor/common.ts` e `vendor/public.ts` são cópias byte a byte verificadas do artefato canônico. O consumidor fixa Zod `4.4.3`, SHA-256 do manifesto e revisão de conteúdo em `vendor/maestro-v1/consumer-manifest.json`. O manifesto canônico não é editado para registrar o consumidor. Os testes usam as mesmas 254 fixtures públicas, 24 bordas públicas e 20 casos consumidores do serviço (298 casos, 137 válidos/161 inválidos).

## Uso da fronteira de conformidade

```ts
import {
  createMaestroConnectCommand,
  toMaestroConnectAck,
  compareMaestroSequences,
} from 'dooers-agents-client/maestro/contracts'

const frame = createMaestroConnectCommand({
  requestId: crypto.randomUUID(),
  authToken: token,
  clientCapabilities: [],
})
// Enviar este frame é responsabilidade do futuro transporte E04-09.
const ack = toMaestroConnectAck(receivedJson)
compareMaestroSequences('9007199254740992', '9007199254740993') // -1
```

O connect não inclui `mode`; `historyAuthority` só aceita `maestro`. Capabilities vazias são válidas e não habilitam nenhuma operação. Ausência do campo obrigatório `capabilities` é inválida. O helper `hasMaestroCapability` não usa semver nem presume capacidade por um schema existir.

Os conversores renomeiam os campos explícitos de identidade, autoria, thread, recibo, erro e paginação para camelCase. Preservam `sequence`/watermark como strings e o cursor integralmente, sem decodificá-lo. `event.payload` mantém o tipo wire de domínio: uma conversão recursiva renomearia indevidamente campos de formulário e conteúdo do usuário. Não fabricam ID, autor, cursor, timestamp, permissão ou confirmação de commit. `MaestroContractError` contém somente o nome fixo do schema; nunca contém input/token ou a árvore bruta de falhas de parse.

Estes validadores/conversores são **estritos** para verificar a baseline congelada. A camada futura de leitura de rede E04-09 deve derivar sua tolerância a campos opcionais adicionais e eventos futuros destes contratos, mantendo comandos estritos. Não ligar estes helpers diretamente a um transporte como se essa compatibilidade já estivesse implementada. Eventos desconhecidos não são aceitos pela conformidade v1; a futura apresentação genérica não pode ativar recursos ou execução.

## Verificação

- `npm run contracts:check`: checksum das oito cópias, inventário, origem, revisão e Zod exato.
- `npm test`: fixtures, conversores e regressão legada.
- `npx tsc --noEmit`: tipos fonte.
- `npm run test:maestro:package`: build, npm pack local, instalação offline temporária, importação real ESM/CJS dos dois entrypoints, 298 casos por formato, compilação de consumidor TypeScript e bundle browser sem imports externos/Node. O diretório temporário é removido ao final.

A instalação offline exige os pacotes do lock no cache local; não busca rede. Nenhum teste usa credencial real, core, banco ou broker. O bundle browser importa apenas common/public e Zod; declarações de delivery, assinatura, Node crypto, React e Zustand não são dependências desse subpath. O catálogo público contém schemas de fronteiras restritas para conformidade; estar disponível no registry não concede autorização nem disponibiliza um método de transporte.
