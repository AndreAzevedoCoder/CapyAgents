import fs from 'node:fs';
import path from 'node:path';
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { checkPaths } from '../permissions/engine.js';
import { ROOT_DIR } from '../env.js';
import type { AgentInstance } from './instance.js';

/**
 * Ferramenta de coleta: baixa um arquivo da web preservando os bytes.
 *
 * Existe porque o WebFetch devolve texto processado — um PDF ou planilha
 * chega como lixo binário — e porque o Write só grava texto que o próprio
 * modelo escreve. Sem isto, um agente de pesquisa não tem como guardar a
 * fonte que encontrou, e quem for ler o documento depois fica sem arquivo.
 *
 * Nada de shell: a rede é falada pelo servidor, não pelo agente. O acesso é
 * regulado pelas mesmas regras do agent.json — o grupo "web" libera a
 * ferramenta e paths.allow/deny decide onde ela pode gravar.
 */

const MAX_BYTES = 64 * 1024 * 1024;
const TIMEOUT_MS = 90_000;

export function makeFileServer(instance: AgentInstance): Record<string, unknown> {
  return createSdkMcpServer({
    name: 'files',
    version: '1.0.0',
    tools: [
      tool(
        'download_file',
        'Baixa um arquivo da web e grava em disco preservando os bytes originais (PDF, CSV, XLSX, ZIP...). ' +
          'Use para guardar a fonte que você encontrou. Para LER o conteúdo depois, use a ferramenta Read, ' +
          'que entende PDF — não tente interpretar o arquivo pelo WebFetch.',
        {
          url: z.string().describe('URL http(s) do arquivo'),
          file_path: z
            .string()
            .describe('Onde gravar, ex.: ./dados/fonte.csv (respeita paths do agent.json)'),
        },
        async (args) => {
          const err = (text: string) => ({
            content: [{ type: 'text' as const, text: `ERRO: ${text}` }],
            isError: true,
          });

          let url: URL;
          try {
            url = new URL(args.url);
          } catch {
            return err(`URL inválida: ${args.url}`);
          }
          if (url.protocol !== 'http:' && url.protocol !== 'https:') {
            return err(`protocolo não permitido: ${url.protocol} (use http ou https)`);
          }

          // Segunda camada de defesa: além do motor que já checou a chamada,
          // o próprio destino é revalidado contra paths.allow/deny.
          const dest = path.isAbsolute(args.file_path)
            ? args.file_path
            : path.resolve(instance.workdir, args.file_path);
          const decision = checkPaths(instance.def.config, ROOT_DIR, [dest]);
          if (!decision.allowed) {
            instance.log('permission', `BLOQUEADO download_file: ${decision.reason}`, args);
            return err(`destino bloqueado pelo agent.json: ${decision.reason}`);
          }

          let res: Response;
          try {
            res = await fetch(url, {
              redirect: 'follow',
              signal: AbortSignal.timeout(TIMEOUT_MS),
              headers: { 'user-agent': 'CapyAgents/1.0 (coleta de dados públicos)' },
            });
          } catch (e) {
            return err(`falha ao buscar: ${e instanceof Error ? e.message : String(e)}`);
          }

          const contentType = res.headers.get('content-type') ?? 'desconhecido';
          if (!res.ok) {
            return err(
              `a URL respondeu ${res.status} ${res.statusText} (content-type ${contentType}). ` +
                'Anote o status no catálogo em vez de insistir.',
            );
          }

          const buf = Buffer.from(await res.arrayBuffer());
          if (buf.byteLength > MAX_BYTES) {
            return err(`arquivo grande demais: ${buf.byteLength} bytes (limite ${MAX_BYTES})`);
          }

          try {
            fs.mkdirSync(path.dirname(dest), { recursive: true });
            fs.writeFileSync(dest, buf);
          } catch (e) {
            return err(`não consegui gravar: ${e instanceof Error ? e.message : String(e)}`);
          }

          const kb = (buf.byteLength / 1024).toFixed(1);
          instance.log('tool_result', `baixado: ${dest} (${kb} kB, ${contentType})`);
          return {
            content: [
              {
                type: 'text' as const,
                text:
                  `Arquivo salvo em ${dest}\n` +
                  `http_status: ${res.status}\n` +
                  `content_type: ${contentType}\n` +
                  `bytes: ${buf.byteLength}\n` +
                  `url_final: ${res.url}\n\n` +
                  'Para ver o conteúdo, use Read neste caminho.',
              },
            ],
          };
        },
      ),
    ],
  }) as unknown as Record<string, unknown>;
}
