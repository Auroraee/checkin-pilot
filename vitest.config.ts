import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.d.ts'],
    },
    projects: [
      {
        test: {
          name: 'unit',
          environment: 'node',
          include: ['tests/unit/**/*.test.ts'],
          setupFiles: ['tests/setup.ts'],
        },
      },
      {
        test: {
          name: 'mock-e2e',
          environment: 'jsdom',
          include: ['tests/mock-e2e/**/*.test.ts'],
          setupFiles: ['tests/setup.ts'],
          // Prebundling this package embeds a second React copy, which breaks
          // hooks in the DOM-rendering tests. Inline it so it shares the
          // external react/react-dom instance.
          server: { deps: { inline: ['@phosphor-icons/react'] } },
        },
      },
    ],
  },
});
