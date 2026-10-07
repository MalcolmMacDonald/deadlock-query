/** The live submission service: the deployed worker. */
export interface SubmitService { readonly url: string }

export const DEFAULT_SUBMIT_SERVICE: SubmitService = {
  url: "https://deadlock-query-submit.m-51c.workers.dev/submit"
}
