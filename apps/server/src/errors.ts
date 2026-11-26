/** Every refusal the API can give. The console translates by code; the message is for other callers. */
export const ERRORS = {
  bad_origin: [403, "This request did not come from Muster."],
  unauthenticated: [401, "Sign in first."],
  forbidden: [403, "Your role does not allow this."],
  owner_only: [403, "Only an owner can manage owners and administrators."],
  self: [400, "You cannot change your own role or status. Ask another administrator."],
  last_owner: [409, "The organization must keep at least one owner."],
  not_found: [404, "Not found."],
  wrong_method: [405, "This address does not take that kind of request."],
  invalid_request: [400, "The request is not valid."],
  too_large: [413, "That is too much to send at once."],
  not_json: [415, "The request body must be JSON."],
  invalid_department_name: [400, "A department name needs 1 to 60 characters."],
  invalid_invitation: [400, "Enter a valid email address and a role."],
  invalid_domain: [400, "Enter a valid domain such as example.com."],
  public_domain: [400, "A public mailbox domain cannot join automatically: anyone could get in."],
  department_missing: [400, "That department does not exist."],
  department_exists: [409, "A department with this name already exists."],
  domain_taken: [409, "This domain is used by another organization."],
  invalid_saml: [
    400,
    "This is not an identity provider's SAML metadata: it needs an entity ID, a sign-in address over https and a signing certificate.",
  ],
  saml_unreachable: [502, "The metadata address could not be read. Paste the metadata instead."],
  saml_untried: [409, "Sign in through it once first: it is switched on only after it has worked."],
  invalid_directory: [
    400,
    "A directory needs its kind, the application's ID and its secret; WeCom also needs the agent ID.",
  ],
  directory_taken: [409, "This application already answers for another organization."],
  directory_busy: [409, "The directory is being read right now. Try again in a moment."],
  directory_refused: [400, "The service does not accept this application ID and secret."],
  directory_not_allowed: [
    409,
    "The service refused this application: it lacks a permission, or this server's address is not on its trusted list.",
  ],
  directory_unreachable: [502, "The directory's service could not be reached. Try again."],
  directory_untried: [
    409,
    "Sign in through it once first: it is switched on only after it has worked.",
  ],
  scim_too_many: [409, "There are 5 provisioning tokens already. Revoke one first."],
  already_member: [409, "This address already belongs to a member."],
  already_invited: [409, "This address already has a pending invitation."],
  invalid_agent: [400, "An agent needs a name, instructions and known tools."],
  agent_unavailable: [409, "This agent is not available to run."],
  agent_name_taken: [409, "You already have an agent with this name."],
  invalid_skill: [400, "A skill needs a name and its instructions."],
  skill_name_taken: [409, "You already have a skill with this name."],
  building_off: [
    403,
    "Your organization does not let members make their own agents, skills or knowledge bases.",
  ],
  sharing_off: [403, "Your organization does not let members share what they made."],
  submitting_off: [403, "Your organization does not let members submit to the marketplace."],
  agent_reach: [
    403,
    "Your organization does not let a member's own agent reach this far. Take out what sends or changes things elsewhere.",
  ],
  not_ready_to_publish: [
    409,
    "It cannot go to the marketplace yet: a skill must pass its scan, and an agent must be approved for use.",
  ],
  listing_changed: [
    409,
    "Its owner changed it after you opened it. Look at it again before deciding.",
  ],
  reason_needed: [400, "Say why, so its maker knows what to change."],
  invalid_schedule: [
    400,
    "A schedule needs what to do, an agent, and a time that is still to come.",
  ],
  too_many_schedules: [
    409,
    "You have 20 schedules, the most one person can have. Delete one first.",
  ],
  connector_off: [403, "Your organization has switched this service off for everyone."],
  invalid_connector: [
    400,
    "A connector needs a name, a public https address and at least one action with a path that starts with /.",
  ],
  connector_credential_again: [
    409,
    "The address changed. Enter the credential again: the one kept was for the old address.",
  ],
  connector_name_taken: [409, "There is already a connector with this name."],
  invalid_mcp_connector: [
    400,
    "An MCP connector needs a name and a public https address with no key in it. A credential goes in its own field.",
  ],
  connector_tool_changed: [
    409,
    "The server changed this tool since you read it. Check again, read it, then switch it on.",
  ],
  connector_too_many_tools: [
    409,
    "A connector can have 30 tools switched on at most. Switch one off first.",
  ],
  connector_too_many: [409, "You have 10 connectors of your own, the most one person can have."],
  connectors_own_off: [
    403,
    "Your organization does not let people add connectors of their own. An administrator can add one for the company.",
  ],
  connector_unsealed: [
    409,
    "This server has no key to keep a credential sealed with. Set MUSTER_SECRET_KEY, then enter the credential.",
  ],
  audit_check_recent: [
    429,
    "The record was checked less than a minute ago. What was found is on the page; check again in a minute.",
  ],
  invalid_forward: [
    400,
    "Sending the record on needs a public https address, on port 443 or 8443, with no username or password in it.",
  ],
  invalid_retention: [
    400,
    "A period is a whole number of days from 30 to 3650, or none; the activity log is kept 365 days at least. A hold needs a reason.",
  ],
  on_hold: [
    409,
    "The organization is under a legal hold: nothing is purged or erased until it is lifted.",
  ],
  erase_not_removed: [
    409,
    "Remove the person from the organization first. Only a removed member's data can be erased.",
  ],
  erase_unconfirmed: [400, "Type the person's email address exactly to confirm."],
  knowledge_name_taken: [409, "You already have a knowledge base with this name."],
  knowledge_full: [409, "This knowledge base is full. Remove something from it, or start another."],
  knowledge_duplicate: [409, "This is already in the knowledge base, exactly as it is."],
  invalid_draft: [400, "A message needs someone to go to and something to say."],
  sending_off: [403, "Your organization has not switched on sending through Muster."],
  sending_not_connected: [
    409,
    "Connect Microsoft 365 again in Settings: you have no connection that can send for you.",
  ],
  draft_sent: [409, "This draft was already sent."],
  draft_busy: [409, "This is being sent right now."],
  draft_unknown: [
    409,
    "This may already have been sent: Microsoft did not say. Look in your Sent Items or the chat before sending it again.",
  ],
  confirm_outside: [409, "This goes outside your organization. Confirm that before it is sent."],
  chat_unknown: [404, "That Teams chat could not be found among yours."],
  send_limit: [429, "That is as many as can be sent in an hour. Try again later."],
  share_self: [400, "It is already yours. Share it with someone else."],
  share_nobody: [404, "There is nobody here to share it with by that id, or they are not active."],
  share_no_department: [404, "There is no department by that id."],
  skill_unavailable: [409, "A skill you picked is not yours to use, or no longer exists."],
  agent_part_unavailable: [
    409,
    "This agent carries a skill, a knowledge base or a connector you can no longer use. Take it out, then save.",
  ],
  skill_not_passed: [
    409,
    "This skill did not pass its scan, so it stays with you. Change what the scan found and save it again.",
  ],
  agent_suspended: [
    409,
    "This agent is suspended. An administrator must restore it before it can be changed.",
  ],
  agent_changed: [409, "This agent changed after you opened it. Look at it again before deciding."],
  connector_unavailable: [
    409,
    "This service is not set up on this server. An operator has to register Muster with it first.",
  ],
  invalid_project: [
    400,
    "A project needs a name of 1 to 60 characters on one line, and instructions of at most 8,000 characters.",
  ],
  project_exists: [409, "You already have a project with this name."],
  notes_changed: [409, "The project's notes were changed while you had them open."],
  invalid_tool_rule: [400, "That is not a rule a tool can be given."],
  invalid_agent_scope: [
    400,
    "That is not something an agent can be held to: sites are host names, such as example.com.",
  ],
  invalid_alert_rule: [400, "That is outside what this alert rule can be set to."],
  invalid_sandbox_host: [
    400,
    "A host is a name such as pypi.org, or *.example.com for every host under one: no address, port or path. Fifty at most.",
  ],
  invalid_sandbox_settings: [
    400,
    "A workspace is released after 1 to 90 days without use, and a cap on all of them is 64 MB at least.",
  ],
  invalid_sandbox_limit: [
    400,
    "An allowance is a number of runs and of processor minutes, 0 for no limit, for everyone, a department or a person of this organization.",
  ],
  sandbox_unavailable: [503, "The sandbox cannot be reached just now."],
  sandbox_not_running: [409, "Nothing is running there any more."],
  sandbox_in_use: [409, "Something is running in that workspace. Stop it first."],
  sandbox_proposal_waiting: [
    409,
    "A proposal in that conversation waits to be sent. Its workspace is kept until the person sends or drops it.",
  ],
  sandbox_held: [409, "Under a legal hold no workspace is released."],
  invalid_alert_webhook: [400, "A webhook needs a public https address."],
  invalid_tracker: [400, "A tracker needs a public https address, its workspace and a key."],
  tracker_key_again: [
    400,
    "Enter the key again: a key is kept only for the address it was entered for.",
  ],
  tracker_unavailable: [
    409,
    "No tracker is connected. An administrator connects one under Connections.",
  ],
  tracker_linked: [409, "This project is already linked. Unlink it first."],
  tracker_not_allowed: [403, "An administrator has not let projects be linked to that one."],
  invalid_code_host: [
    400,
    "A code host needs a key, and for GitHub Enterprise the https address of its API. A repository is named owner/name.",
  ],
  code_host_key_again: [
    400,
    "Enter the key again: a key is kept only for the address it was entered for.",
  ],
  code_host_unavailable: [
    409,
    "The code host is not connected, or work on repositories is not set up on this server.",
  ],
  repo_not_allowed: [403, "That repository is not one agents may work on here."],
  repo_nothing: [409, "No work waits to be sent in this conversation."],
  repo_changed: [409, "The work changed after you were shown it. Look at it again, then send it."],
  invalid_step: [400, "A step needs a title; its due date is a day."],
  step_agent: [400, "That agent cannot be given a step."],
  project_view_only: [403, "You can see this project, not change it."],
  project_owner_only: [403, "Only the project's owner can do this."],
  invalid_member: [400, "A project's people are colleagues, each to see it or to work in it."],
  too_many_members: [409, "This project has as many people as a project holds."],
  invalid_item: [
    400,
    "A thing kept in a project needs a name, and an address that begins with https:// or http://; a repository is named owner/name.",
  ],
  too_many_items: [409, "This project keeps as many things as a project holds. Remove one first."],
  item_exists: [409, "That repository is already in the project."],
  item_secret: [
    422,
    "That looks like a key or a password; keep where it is found, not the secret itself.",
  ],
  invalid_doc: [
    400,
    "A key document is one of your files, pinned as a spec, decisions, research, release notes or other.",
  ],
  too_many_docs: [
    409,
    "This project has as many key documents as a project holds. Unpin one that no longer matters.",
  ],
  invalid_update: [
    400,
    "An update says how the project is going, in 2,000 characters at most, and whether it is on track, at risk or off track.",
  ],
  too_many_steps: [
    409,
    "This project has as many steps as a project holds. Remove ones that no longer matter.",
  ],
  invalid_document: [
    400,
    "A document needs a title of 1 to 120 characters, and holds at most 200,000 characters.",
  ],
  document_exists: [409, "You already have a document with this title."],
  invalid_file_name: [400, "A file needs a name of 1 to 200 characters."],
  empty_file: [400, "That file is empty. There is nothing in it to keep."],
  file_too_large: [413, "That file is larger than this server accepts."],
  unsupported_file: [
    415,
    "That kind of file is not accepted, or its content does not match its name.",
  ],
  unreadable_file: [422, "This file could not be read for viewing. Download it to open it."],
  comments_full: [409, "This file has as many comments as it can hold. Resolve some first."],
  protected_file: [
    415,
    "This file is protected by a password or a sensitivity label, so it cannot be opened here. Remove the protection and upload it again.",
  ],
  file_quota: [409, "You have no space left for this file. Delete some files first."],
  form_closed: [
    409,
    "This form can no longer be answered: it was answered already, or the conversation has moved on.",
  ],
  invalid_form: [400, "These answers do not fit the form. Check each field and send it again."],
  run_in_progress: [
    409,
    "This conversation is still working on the previous message. Words can be added to it; a file, a skill or another agent waits for the reply.",
  ],
  nothing_to_continue: [
    409,
    "There is nothing to go on with here. Send the message again to start over.",
  ],
  already_decided: [409, "This request was already decided."],
  nothing_to_compact: [
    409,
    "There is too little here to compact: a conversation is compacted once it has at least six messages, and new ones since the last time.",
  ],
  compact_failed: [
    502,
    "The conversation could not be summarised just now. Try again in a moment.",
  ],
  budget_reached: [429, "You have used today's allowance for agents. It starts again tomorrow."],
  budget_person: [
    429,
    "You have reached your limit for agents this month. It starts again on the 1st. An administrator of Muster at your company can raise it.",
  ],
  budget_department: [
    429,
    "Your department has reached its budget for agents this month. It starts again on the 1st. An administrator of Muster at your company can raise it.",
  ],
  budget_company: [
    429,
    "The company has reached its budget for agents this month. It starts again on the 1st. An administrator of Muster at your company can raise it.",
  ],
  invalid_budget: [400, "A limit is a sum of money for the company, a department or a person."],
  invalid_model: [400, "The model or its service is not filled in as it must be."],
  invalid_model_key: [
    400,
    "That does not look like a key: it holds a space, a quote or a line break, or is too short.",
  ],
  model_unsealed: [
    409,
    "The server has no key to seal this with. Set MUSTER_SECRET_KEY on the server, then enter the key again.",
  ],
  model_key_again: [
    409,
    "The address changed, so enter the key again: the one kept was entered for the old address.",
  ],
  model_service_in_use: [409, "Models are still set up at this service. Remove them first."],
  model_in_use: [409, "Agents run on this model. Choose another one first."],
  model_no_key: [409, "This model's service has no key yet. Enter one first."],
  model_unavailable: [503, "No model is configured, so agents cannot run."],
} as const;
export type ErrorCode = keyof typeof ERRORS;

/** Thrown inside a transaction so the transaction rolls back before the refusal is sent. */
export class Refusal extends Error {
  constructor(readonly code: ErrorCode) {
    super(code);
  }
}
