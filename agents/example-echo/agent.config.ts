import { defineAgent, topic } from '@nexora/contracts';

export default defineAgent({
  name: 'example-echo',
  version: '0.1.0',
  description: 'TODO: describe what example-echo does',
  architecture: 'react',
  tools: ["read","grep"],
  capabilities: [],
  subscribes: [topic('example-echo.requested')],
  publishes: [topic('example-echo.completed')],
});
