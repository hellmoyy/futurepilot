// app/layout.js

export const metadata = {
  title: 'FuturePilot Bot Dashboard',
  description: 'Dashboard untuk memonitor bot Telegram FuturePilot',
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>
        {children}
      </body>
    </html>
  );
}