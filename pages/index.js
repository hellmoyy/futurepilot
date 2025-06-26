// pages/index.js
import { useState } from 'react';

export default function Home() {
  const [log, setLog] = useState([]);
  // nanti bisa fetch log dari server atau WebSocket
  return (
    <div className="p-8">
      <h1 className="text-2xl font-bold">FuturePilot Bot Dashboard</h1>
      <pre className="mt-4 bg-gray-100 p-4">{log.join('\n')}</pre>
    </div>
  );
}