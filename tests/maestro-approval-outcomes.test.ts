import { expect, it, vi } from 'vitest'
import { MaestroApprovalOutcomes, maestroApprovalOutcomeSchema, type MaestroApprovalOutcomeBinding } from '../src/maestro/approval-outcomes'
import { MaestroClientError } from '../src/maestro/types'
import { approvalId, publicCommitment } from './fixtures/maestro-approval'
import { threadId, tick, uuid } from './fixtures/maestro-replay'
const binding = (): MaestroApprovalOutcomeBinding => ({ deliveryId: uuid(404), agentParticipantId: uuid(402), argumentsHash: publicCommitment, decisionEventId: uuid(2), approved: true })
const outcome = (status: 'unobserved' | 'pending' | 'succeeded' | 'unknown' | 'manual_review' = 'succeeded', revision: string | null = '1') => ({ format_version: 'maestro.tool-approval-outcome.local.v1', interaction_id: approvalId, delivery_id: uuid(404), agent_participant_id: uuid(402), decision_event_id: uuid(2), arguments_hash: publicCommitment, status, revision })
const setup = (read = vi.fn(async () => outcome()), expected = binding(), authorize = vi.fn()) => {
  const manager = new MaestroApprovalOutcomes(read, () => expected, authorize)
  return { manager, read, expected, authorize }
}
it.each(['unobserved','pending','succeeded','unknown','manual_review'] as const)('projects authorized %s independently from approval', async status => {
  const { manager, expected } = setup(vi.fn(async () => outcome(status, status === 'unobserved' ? null : '1')))
  await manager.refresh(threadId, approvalId)
  expect(manager.current(threadId, approvalId, expected).state).toBe(status)
  manager.clear()
})
it('coalesces concurrent refresh and never creates a decision', async () => {
  let finish!: (value: ReturnType<typeof outcome>) => void
  const { manager, read } = setup(vi.fn(() => new Promise(resolve => { finish = resolve })))
  const a = manager.refresh(threadId, approvalId), b = manager.refresh(threadId, approvalId)
  expect(a).toBe(b); await tick(); finish(outcome()); await a; expect(read).toHaveBeenCalledTimes(1)
})
it('outcome before replay remains unobserved until the exact approved event is canonical locally', async () => {
  const expected = { ...binding(), decisionEventId: null, approved: false }
  const { manager } = setup(undefined, expected)
  await manager.refresh(threadId, approvalId)
  expect(manager.current(threadId, approvalId, expected).state).toBe('unobserved')
  expected.decisionEventId = uuid(2); expected.approved = true
  expect(manager.current(threadId, approvalId, expected).state).toBe('succeeded')
  expected.decisionEventId = uuid(999)
  expect(manager.current(threadId, approvalId, expected).state).toBe('unobserved')
})
it.each(['interaction_id','delivery_id','agent_participant_id','arguments_hash','decision_event_id'] as const)('rejects mismatched %s without showing success', async field => {
  const dto = outcome(); (dto as any)[field] = field === 'arguments_hash' ? 'b'.repeat(64) : uuid(999)
  const { manager, expected } = setup(vi.fn(async () => dto))
  await expect(manager.refresh(threadId, approvalId)).rejects.toMatchObject({ code: 'PROTOCOL_ERROR' })
  expect(manager.current(threadId, approvalId, expected).state).toBe('unobserved')
})
it.each(['private_nonce','effect_key','receipt_id','arguments','private_binding'] as const)('strict DTO rejects private extra %s', async field => {
  const { manager } = setup(vi.fn(async () => ({ ...outcome(), [field]: 'secret' })))
  await expect(manager.refresh(threadId, approvalId)).rejects.toMatchObject({ code: 'PROTOCOL_ERROR' })
})
it('non-unobserved needs a decision and positive decimal revision; null revision is unobserved only', () => {
  for (const invalid of [{...outcome(),revision:null},{...outcome(),revision:'0'},{...outcome(),revision:'01'},{...outcome(),decision_event_id:null},{...outcome('unobserved'),revision:'1'}]) expect(maestroApprovalOutcomeSchema.safeParse(invalid).success).toBe(false)
})
it('stale revision and changed content at the same revision fail without forgetting monotonic history', async () => {
  const read = vi.fn().mockResolvedValueOnce(outcome('succeeded','5')).mockResolvedValueOnce(outcome('pending','4')).mockResolvedValueOnce(outcome('unknown','5')).mockResolvedValueOnce(outcome('succeeded','6'))
  const { manager, expected } = setup(read)
  await manager.refresh(threadId, approvalId)
  await expect(manager.refresh(threadId, approvalId)).rejects.toMatchObject({ code: 'PROTOCOL_ERROR' })
  expect(manager.current(threadId, approvalId, expected).state).toBe('unobserved')
  await expect(manager.refresh(threadId, approvalId)).rejects.toMatchObject({ code: 'PROTOCOL_ERROR' })
  await manager.refresh(threadId, approvalId); expect(manager.current(threadId, approvalId, expected)).toMatchObject({state:'succeeded',revision:'6'})
})
it('unobserved may acquire its canonical decision without inventing a journal revision', async () => {
  const read = vi.fn().mockResolvedValueOnce({...outcome('unobserved',null),decision_event_id:null}).mockResolvedValueOnce(outcome('unobserved',null))
  const expected = {...binding(),decisionEventId:null,approved:false}
  const { manager } = setup(read, expected)
  await manager.refresh(threadId, approvalId); expected.decisionEventId=uuid(2);expected.approved=true
  await manager.refresh(threadId, approvalId);expect(manager.current(threadId, approvalId, expected).state).toBe('unobserved')
})
it('scope cleanup aborts the read and cannot publish a late success', async () => {
  let finish!: (value: ReturnType<typeof outcome>) => void; let signal!: AbortSignal
  const read=vi.fn((_thread:string,_target:string,abort:AbortSignal)=>{signal=abort;return new Promise(resolve=>{finish=resolve})})
  const { manager } = setup(read as never)
  const pending=manager.refresh(threadId,approvalId);await tick();manager.removeThread(threadId);expect(signal.aborted).toBe(true);finish(outcome())
  await expect(pending).rejects.toMatchObject({code:'FORBIDDEN'});expect(manager.getSnapshot()).toEqual([])
})
it('current read authorization is rechecked after await and cached success is hidden after loss', async () => {
  const authorize=vi.fn();const {manager,expected}=setup(undefined,undefined,authorize)
  await manager.refresh(threadId,approvalId);authorize.mockImplementation(()=>{throw new MaestroClientError('FORBIDDEN','Read revoked')})
  expect(manager.current(threadId,approvalId,expected).state).toBe('unobserved')
  await expect(manager.refresh(threadId,approvalId)).rejects.toMatchObject({code:'FORBIDDEN'})
})
it('last hook lease aborts and discards a late result while a second lease keeps the read alive', async () => {
  let finish!: (value: ReturnType<typeof outcome>) => void;let signal!: AbortSignal
  const read=vi.fn((_thread:string,_target:string,abort:AbortSignal)=>{signal=abort;return new Promise(resolve=>{finish=resolve})})
  const {manager}=setup(read as never);const releaseA=manager.retain(threadId,approvalId),releaseB=manager.retain(threadId,approvalId)
  const pending=manager.refresh(threadId,approvalId);await tick();releaseA();expect(signal.aborted).toBe(false);releaseB();expect(signal.aborted).toBe(true)
  finish(outcome());await expect(pending).rejects.toMatchObject({code:'FORBIDDEN'});expect(manager.getSnapshot()).toEqual([])
})
