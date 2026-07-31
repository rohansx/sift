// Placeholder. It exists to prove the toolchain compiles a shadcn component and
// that the assets land in dist/ui — the screens land in the following commits.
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

export default function App() {
  return (
    <main className="mx-auto flex min-h-svh max-w-2xl flex-col justify-center gap-4 p-6">
      <Card>
        <CardHeader>
          <CardTitle className="font-mono">sift</CardTitle>
          <CardDescription>
            Dashboard scaffold. No screens yet — this page only proves the build
            ships.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button variant="outline" asChild>
            <a href="https://github.com/siftlabs/sift">Read the docs</a>
          </Button>
        </CardContent>
      </Card>
    </main>
  );
}
