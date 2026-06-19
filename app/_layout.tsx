import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider } from "react-native-safe-area-context";

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      {/* Ensures status bar elements match your dark theme canvas */}
      <StatusBar style="light" backgroundColor="#0f172a" />
      
      {/* The Stack component manages the screen transitions */}
      <Stack
        screenOptions={{
          headerShown: false, // Hides the default white native header bar
          contentStyle: { backgroundColor: "#0f172a" }, // Global background color
        }}
      >
        {/* Defines your main dashboard entry point screen */}
        <Stack.Screen name="index" />
      </Stack>
    </SafeAreaProvider>
  );
}