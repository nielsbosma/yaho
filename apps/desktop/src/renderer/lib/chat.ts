/** Open Chat with Yaho on a job: follow-ups go to that job's agent and resume its session. */
export const chatAboutJob = (job: string) => window.dispatchEvent(new CustomEvent('yaho:chat-job', { detail: job }));
