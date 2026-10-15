import { describe, expect, it } from 'vitest'
import { maestroCommercialBlock } from '../src/maestro/commercial'
describe('commercial public projection',()=>{
 it.each(['insufficient_balance','org_limit_exceeded','billing_policy_unavailable','model_not_allowed','gateway_correlation_unavailable','operation_already_started'])('has a nonretrying action for %s',reason=>{
  expect(maestroCommercialBlock(reason)).toMatchObject({reasonCode:reason,retryable:false});expect(JSON.stringify(maestroCommercialBlock(reason))).not.toMatch(/price|amount|cost|token/);
 })
 it.each([null,undefined,'constructor','toString','network_error','secret-token','quota_exceeded'])('does not infer commercial denial for %s',reason=>expect(maestroCommercialBlock(reason)).toBeNull())
})
