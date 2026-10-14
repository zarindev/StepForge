import { installAppium, nativeDoctor } from '@stepforge/executor-native';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.ts';

/** Android apps: what this computer has (SDK, Java, emulators, phones, Appium), and installing Appium. */
export function registerNativeRoutes(app: FastifyInstance, ctx: AppContext) {
  const toolsDir = ctx.config.toolsDir;
  let installing: Promise<void> | null = null;
  app.get('/api/native/status', async () => ({
    ...(await nativeDoctor(toolsDir)),
    installing: !!installing,
  }));
  app.post('/api/native/appium/install', async (_req, reply) => {
    installing ??= installAppium(toolsDir, (m) => app.log.info(`appium: ${m}`)).finally(() => {
      installing = null;
    });
    try {
      await installing;
    } catch (err) {
      return reply.code(502).send({ error: 'install_failed', message: (err as Error).message });
    }
    return nativeDoctor(toolsDir);
  });
}
