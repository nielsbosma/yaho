/** Open Chat with Yaho on a job: follow-ups go to that job's agent and resume its session. */
export const chatAboutJob = (job: string) => window.dispatchEvent(new CustomEvent('yaho:chat-job', { detail: job }));

/** Open Chat with Yaho about an agent: the assistant gets its definition and recent jobs, and can change it. */
export const chatAboutAgent = (agent: string) => window.dispatchEvent(new CustomEvent('yaho:chat-agent', { detail: agent }));
