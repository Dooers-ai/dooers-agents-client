import { event, scope, uuid } from './maestro-replay'
export const interactionId = uuid(301)
export const form = () => {
 const e = event(1, 'interaction.created')
 e.payload.interaction = { interaction_id: interactionId, origin_event_id: uuid(300), agent_participant_id: uuid(302), execution_id: uuid(303), delivery_id: uuid(304), state: 'pending', definition: { kind:'form',schema_version:1,title:'Durable input',expires_at:'2099-01-01T00:00:00Z',eligible_participant_ids:[uuid(305)],actions:['submit','cancel'],fields:[{name:'name',label:'Name',type:'text',required:true,share_response:true,max_length:20},{name:'private_note',label:'Private',type:'text',required:false,share_response:false,max_length:40},{name:'file',label:'File',type:'artifact',required:false,share_response:false,max_files:2}] } }
 return e
}
export const responded = (action: 'submit' | 'cancel' = 'submit', principal = scope.principalId) => { const e=event(2,'interaction.responded');e.actor={kind:'human',principal_id:principal,participant_id:uuid(305),display_name:'Human'};e.payload={interaction_id:interactionId,action,shared_data:action==='submit'?{name:'Ada'}:{},delivery_id:uuid(304),phase_id:interactionId};return e }
