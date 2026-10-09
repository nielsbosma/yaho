/** Open Chat with Yaho on a job: follow-ups go to that job's agent and resume its session. */
export const chatAboutJob = (job: string) => window.dispatchEvent(new CustomEvent('yaho:chat-job', { detail: job }));

/** An agent or project the chat is about: the assistant gets its details and can change it. */
export interface ChatFocus {
  kind: 'agent' | 'project';
  name: string;
}
const chatAbout = (focus: ChatFocus) => window.dispatchEvent(new CustomEvent('yaho:chat-focus', { detail: focus }));
export const chatAboutAgent = (name: string) => chatAbout({ kind: 'agent', name });
export const chatAboutProject = (name: string) => chatAbout({ kind: 'project', name });
