"use client";

import { useEffect, useState } from "react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { getSupabaseBrowser } from "@/lib/supabase-browser";

export default function SignInPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);

  const primaryButtonClass =
    "rounded-full bg-[#234167] px-5 py-2.5 text-sm font-medium text-white transition hover:bg-black disabled:cursor-not-allowed disabled:opacity-60";
  const cardClass = "rounded-[24px] border border-[#dce8ec] bg-white shadow-[0_14px_35px_-24px_rgba(0,0,0,0.45)]";

  useEffect(() => {
    const bootstrap = async () => {
      const supabase = getSupabaseBrowser();
      const { data, error } = await supabase.auth.getSession();
      if (error) {
        await supabase.auth.signOut();
        return;
      }
      if (data.session?.access_token) {
        router.replace("/");
      }
    };
    void bootstrap();
  }, [router]);

  async function signIn() {
    setLoading(true);
    setMessage("");
    try {
      const supabase = getSupabaseBrowser();
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) {
        setMessage(error.message);
        return;
      }
      router.replace("/");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Sign in failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="min-h-screen bg-[#f3fbfd] p-8 text-slate-900">
      <div className={`mx-auto mt-16 max-w-md space-y-4 p-8 ${cardClass}`}>
        <Image src="/digirx-logo.svg" alt="DigiRX" width={144} height={50} />
        <h1 className="text-4xl font-medium text-[#101828]">Sign In</h1>
        <p className="text-sm text-[#5a6a74]">Use your account to access saved comparison runs.</p>
        <input
          className="w-full rounded-full border border-[#d2e6ea] bg-white px-4 py-2.5 text-sm outline-none transition focus:border-[#6cc8dd]"
          placeholder="Email"
          type="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
        />
        <input
          className="w-full rounded-full border border-[#d2e6ea] bg-white px-4 py-2.5 text-sm outline-none transition focus:border-[#6cc8dd]"
          placeholder="Password"
          type="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
        <button type="button" className={primaryButtonClass} onClick={signIn} disabled={loading}>
          {loading ? "Signing In..." : "Sign In"}
        </button>
        {message ? <p className="text-sm text-[#5a6a74]">{message}</p> : null}
      </div>
    </main>
  );
}
