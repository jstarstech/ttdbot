import fs from 'node:fs/promises';
import jsYaml from 'js-yaml';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const workspaceRoot = path.resolve(__dirname, '../../..');

export async function loadConfig(configFile = workspaceRoot + '/config.yml'): Promise<Config> {
    return jsYaml.load(await fs.readFile(configFile, 'utf8')) as Config;
}

export interface Config {
    dataDir: string;
    logLevel: string;
    api_id: number;
    api_hash: string;
    discord_bot_token: string;
    session_name: string;
    input_channel_names: [];
    input_channel_ids: number[];
    output_channel_ids: [];
    discord_channel: string[];
    /** Gates the gramjs user-account source (defaults to enabled). */
    user_client?: { enabled?: boolean };
    /** Enables and configures the grammY Bot API source. */
    bot?: BotConfig;
}

export interface BotConfig {
    enabled?: boolean;
    /** Bot token from @BotFather. */
    token: string;
    /** Bot API endpoint. Empty = Telegram cloud (20 MB media); a URL = self-hosted server (up to 2 GB). */
    api_server?: string;
    /**
     * For a `--local` self-hosted server: getFile returns an absolute path inside the
     * server's data dir. api_server_dir is that dir (the server's `--dir`); api_files_url
     * is an HTTP base (e.g. an nginx sidecar) serving it. The app strips the dir prefix
     * and fetches `${api_files_url}/<relative>`. Leave both unset for the cloud / a
     * non-local server (standard /file HTTP download), or set only api_server_dir to read
     * the path directly when the app shares the server's filesystem.
     */
    api_server_dir?: string;
    api_files_url?: string;
    /** User IDs permitted to submit via DM (deny by default). */
    allowed_user_ids?: number[];
    /** Chat IDs of channels the bot reads as admin (deny by default). */
    allowed_chat_ids?: number[];
}
