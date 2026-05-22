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
}
