import { createContext, useContext, useState, type ReactNode } from "react";

export type Environment = "production" | "staging" | "development";
export type TimeRange = "1h" | "24h" | "7d" | "30d" | "custom";

type Ctx = {
  environment: Environment;
  setEnvironment: (e: Environment) => void;
  timeRange: TimeRange;
  setTimeRange: (t: TimeRange) => void;
};

const AppCtx = createContext<Ctx>({
  environment: "production",
  setEnvironment: () => {},
  timeRange: "24h",
  setTimeRange: () => {},
});

export function AppContextProvider({ children }: { children: ReactNode }) {
  const [environment, setEnvironment] = useState<Environment>("production");
  const [timeRange, setTimeRange] = useState<TimeRange>("24h");
  return (
    <AppCtx.Provider value={{ environment, setEnvironment, timeRange, setTimeRange }}>
      {children}
    </AppCtx.Provider>
  );
}

export const useAppContext = () => useContext(AppCtx);
