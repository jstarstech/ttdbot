import fs from 'fs-extra';
import jsYaml from 'js-yaml';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const workspaceRoot = path.resolve(__dirname, '../../..');

export async function initConfig() {
    const config: Config = jsYaml.load(fs.readFileSync(workspaceRoot + '/config.yml', 'utf8')) as Config;

    config.dataDir = path.resolve(workspaceRoot, config.dataDir);

    if (!fs.existsSync(config.dataDir)) {
        await fs.mkdir(config.dataDir);
    }

    if (!fs.existsSync(config.dataDir + '/logs')) {
        await fs.mkdir(config.dataDir + '/logs');
    }

    if (!fs.existsSync(config.dataDir + '/telegram_media')) {
        await fs.mkdir(config.dataDir + '/telegram_media');
    }

    if (!fs.existsSync(config.dataDir + '/convert')) {
        await fs.mkdir(config.dataDir + '/convert');
    }

    return config;
}

const Config = await initConfig().catch(e => {
    console.error(e);

    process.exit(1);
});

export default Config;

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
