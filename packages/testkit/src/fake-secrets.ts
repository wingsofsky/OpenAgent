// Fake secrets for the redaction tests. They are assembled at run time, so the source holds no key-shaped literal
// that a secret scanner or a reader could take for a leak.
const join = (...parts: string[]) => parts.join("");

/** An OpenAI-style key */
export const FAKE_KEY = join("sk-", "test", "Q7xR2mK9", "pL4vN8wZ", "3bT6yH1c", "F5jD0sA");
/** A shorter key of the same shape */
export const FAKE_SHORT_KEY = join("sk-", "abcDEF12", "34567890", "abcdef12");
/** A Semantic Scholar-style key */
export const FAKE_S2_KEY = join("s2k-", "AbCdEf12", "34567890", "12345");
/** A bare high-entropy token */
export const FAKE_TOKEN = join("Xy7Zw1Qa", "2Ws3Ed4R", "f5Tg6Yh7", "Uj8Ik9Ol", "0Pz1Xc2V", "b3Nm4");
/** A bare secret of the kind a password field holds */
export const FAKE_SECRET = join("Q7xR2mK9", "pL4vN8wZ", "3bT6yH1c", "F5jD0sA");
/** A PEM block around a fake body */
export const FAKE_PEM = (body: string) => join("-----BEGIN ", "PRIVATE KEY", "-----\n", body, "\n-----END ", "PRIVATE KEY", "-----");
