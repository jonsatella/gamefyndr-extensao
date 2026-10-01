/**
 * No servidor, `epic.ts` registra no log do app. Na extensão não há log pra
 * mandar nada: isto só escreve no console da própria extensão, e nunca com
 * token (o `epic.ts` já não passa token pro log).
 */
const escrever = (nivel: "info" | "warn" | "error") => (obj: unknown, msg?: string) =>
  console[nivel](msg ?? "", obj);

export const logger = { info: escrever("info"), warn: escrever("warn"), error: escrever("error") };
