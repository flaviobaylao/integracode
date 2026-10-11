/**
 * Compressao gzip das respostas JSON da API (PERF, 11/out/2026).
 *
 * Sem dependencia nova de proposito (o registro npm nem sempre esta' na allowlist
 * do ambiente de build): usa o zlib do proprio Node. So' comprime o que vale a pena —
 * resposta de `res.json()` com mais de 1 KB, quando o navegador aceita gzip e a rota
 * nao marcou `res.locals.semCompressao`. Listas grandes (pipeline, clientes, NF-e)
 * caem para 15-30% do tamanho. Streams, arquivos e imagens nao passam por aqui.
 */
import type { Request, Response, NextFunction } from 'express';
import { gzipSync } from 'zlib';

const LIMIAR_BYTES = 1024;

export function compressJson() {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.path.startsWith('/api/')) return next();
    const aceita = String(req.headers['accept-encoding'] || '');
    if (!/\bgzip\b/i.test(aceita)) return next();

    const jsonOriginal = res.json.bind(res);
    res.json = function (body: any) {
      try {
        if ((res as any).locals?.semCompressao || res.headersSent) return jsonOriginal(body);
        const texto = JSON.stringify(body);
        if (texto === undefined || Buffer.byteLength(texto) < LIMIAR_BYTES) return jsonOriginal(body);
        const gz = gzipSync(Buffer.from(texto, 'utf8'), { level: 5 });
        if (!res.getHeader('Content-Type')) res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Content-Encoding', 'gzip');
        res.setHeader('Vary', 'Accept-Encoding');
        res.removeHeader('Content-Length');
        res.setHeader('Content-Length', String(gz.length));
        return res.end(gz) as any;
      } catch {
        return jsonOriginal(body);
      }
    } as any;
    next();
  };
}
