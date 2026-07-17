import { dirname, resolve } from "std/path";

export type Profile = {
  id: string;
  name: string;
  createdAt: string;
};

type ProfilesFile = {
  profiles: Profile[];
};

export class ProfileStore {
  #path: string;

  constructor(path = ".cache/profiles.json") {
    this.#path = resolve(path);
  }

  async all(): Promise<Profile[]> {
    const file = await this.load();
    return file.profiles;
  }

  async find(id: string | undefined): Promise<Profile | undefined> {
    if (!id) {
      return undefined;
    }

    return (await this.all()).find((profile) => profile.id === id);
  }

  async create(name: string): Promise<Profile> {
    const trimmed = name.trim();
    if (!trimmed) {
      throw new Error("Profile name is required.");
    }

    const file = await this.load();
    const existingIds = new Set(file.profiles.map((profile) => profile.id));
    const profile = {
      id: uniqueProfileId(slugify(trimmed), existingIds),
      name: trimmed,
      createdAt: new Date().toISOString(),
    };
    file.profiles.push(profile);
    await this.save(file);

    return profile;
  }

  private async load(): Promise<ProfilesFile> {
    try {
      const raw = await Deno.readTextFile(this.#path);
      const file = JSON.parse(raw) as ProfilesFile;
      return {
        profiles: Array.isArray(file.profiles) ? file.profiles : [],
      };
    } catch (error) {
      if (
        !(error instanceof Deno.errors.NotFound) &&
        !(error instanceof SyntaxError)
      ) {
        throw error;
      }
    }

    return { profiles: [] };
  }

  private async save(file: ProfilesFile): Promise<void> {
    await Deno.mkdir(dirname(this.#path), { recursive: true });
    await Deno.writeTextFile(this.#path, `${JSON.stringify(file, null, 2)}\n`);
  }
}

export function selectedProfileId(request: Request): string | undefined {
  const cookie = request.headers.get("cookie");
  if (!cookie) {
    return undefined;
  }

  return cookie.split(";")
    .map((part) => part.trim())
    .map((part) => part.split("="))
    .find(([name]) => name === "cake_profile")?.[1];
}

export function profileCookie(profile: Profile): string {
  return [
    `cake_profile=${encodeURIComponent(profile.id)}`,
    "Path=/",
    "SameSite=Lax",
    "Max-Age=31536000",
  ].join("; ");
}

function uniqueProfileId(base: string, existingIds: Set<string>): string {
  let id = base || "profile";
  let suffix = 2;

  while (existingIds.has(id)) {
    id = `${base}-${suffix}`;
    suffix++;
  }

  return id;
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
