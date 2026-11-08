"use client";

import { useEffect, useState } from "react";
import { getSupabaseBrowserClient } from "../../lib/supabase/browser";

/**
 * Values the browser already knows about the signed-in traveller.
 *
 * Hotel and flight providers reject empty holder/passenger blocks, so the
 * checkout forms start from the session instead of asking for the same name and
 * email again. Anything the profile cannot answer stays empty and is typed by
 * the traveller.
 */
export interface TravellerDefaults {
  firstName: string;
  lastName: string;
  email: string;
}

const EMPTY: TravellerDefaults = {
  firstName: "",
  lastName: "",
  email: "",
};

function splitName(value: string): { firstName: string; lastName: string } {
  const parts = value.trim().split(" ").filter(Boolean);
  const [firstName = "", ...rest] = parts;
  return { firstName, lastName: rest.join(" ") };
}

export function useTraveller(): TravellerDefaults {
  const [traveller, setTraveller] = useState<TravellerDefaults>(EMPTY);

  useEffect(() => {
    let active = true;
    const supabase = getSupabaseBrowserClient();

    async function load() {
      const { data } = await supabase.auth.getUser();
      const user = data.user;
      if (!active || !user) return;
      const { data: profile } = await supabase
        .from("profiles")
        .select("name")
        .eq("id", user.id)
        .maybeSingle();
      if (!active) return;
      const { firstName, lastName } = splitName(
        typeof profile?.name === "string" ? profile.name : "",
      );
      const email = user.email ?? "";
      setTraveller({
        firstName: firstName || email.split("@")[0] || "",
        lastName,
        email,
      });
    }

    void load();
    return () => {
      active = false;
    };
  }, []);

  return traveller;
}
