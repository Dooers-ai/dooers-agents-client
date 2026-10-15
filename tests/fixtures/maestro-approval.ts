import { event, scope, thread, uuid } from './maestro-replay'
export const approvalId = uuid(401)
export const publicCommitment = 'a'.repeat(64)
export const approval = (sequence = 1, target = approvalId, agent = uuid(402)) => {
  const e = event(sequence, 'interaction.created')
  e.payload.interaction = {
    interaction_id: target, origin_event_id: uuid(400), agent_participant_id: agent,
    execution_id: uuid(403), delivery_id: uuid(404), state: 'pending',
    definition: { kind: 'tool_approval', schema_version: 1, title: 'Update sandbox flag',
      tool_name: 'sandbox.set_flag', action_description: 'Set reviewed to true for sandbox target 405',
      effect_scope: 'One boolean flag in sandbox account 406', arguments_hash: publicCommitment,
      expires_at: '2099-01-01T00:00:00Z', eligible_participant_ids: [uuid(305)], actions: ['approve', 'reject'] },
  }
  return e
}
export const approvalDecision = (action: 'approve' | 'reject' | 'cancel' = 'approve', target = approvalId, sequence = 2) => {
  const e = event(sequence, 'interaction.responded')
  e.actor = { kind: 'human', principal_id: scope.principalId, participant_id: uuid(305), display_name: 'Human' }
  e.payload = { interaction_id: target, action, shared_data: {}, delivery_id: uuid(404), phase_id: target }
  return e
}
export const approvalThread = () => {
  const t = thread('1'); t.capabilities.push('interactions.tool_approval'); t.permissions.write = true
  t.participants = [
    { participant_id: uuid(305), kind: 'human', principal_id: scope.principalId, role: 'owner', state: 'active', joined_sequence: '1', left_sequence: null, display_name: 'Human' },
    { participant_id: uuid(402), kind: 'agent', principal_id: uuid(407), instance_agent_id: uuid(408), capabilities: ['interactions.tool_approval'], availability: 'available', role: 'member', state: 'active', joined_sequence: '1', left_sequence: null, display_name: 'Agent' },
  ]
  return t
}
