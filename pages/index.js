import { useEffect } from 'react';
import { useRouter } from 'next/router';

// The app is one page now. Everything else is shelved behind /roadmap.
export default function Home() {
  const router = useRouter();

  useEffect(() => {
    router.replace('/deals');
  }, [router]);

  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-50">
      <p className="text-sm text-slate-500">Loading deals…</p>
    </div>
  );
}
