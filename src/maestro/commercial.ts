/** Public reason allowlist. A failed execution alone never confirms a debit or price. */
const actions = {
  insufficient_balance: 'review_balance',
  org_limit_exceeded: 'review_limits',
  billing_policy_unavailable: 'contact_administrator',
  model_not_allowed: 'review_model',
  gateway_correlation_unavailable: 'contact_administrator',
  operation_already_started: 'contact_administrator',
} as const
export function maestroCommercialBlock(reason: string | null | undefined) {
  if (!reason || !Object.hasOwn(actions, reason)) return null
  const code = reason as keyof typeof actions
  return { reasonCode: code, action: actions[code], retryable: false as const }
}
