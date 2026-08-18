export function githubGitEnvironment(token: string, cloneUrl: string) {
  const origin = new URL(cloneUrl).origin;
  return {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: `http.${origin}/.extraheader`,
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${btoa(`x-access-token:${token}`)}`,
  };
}
