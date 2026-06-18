'use client';

import AgentChat from '@/components/chat/AgentChat';
import { ApplicationProvider } from '@/context/ApplicationContext';

export default function AdminChatPage() {
  return (
    <ApplicationProvider>
      <AgentChat />
    </ApplicationProvider>
  );
}
