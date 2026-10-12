/** Vite turns an imported image into its URL. */
declare module '*.svg' {
  const url: string;
  export default url;
}
