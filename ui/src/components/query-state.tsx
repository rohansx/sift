import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";

/** Rows-shaped placeholder, so the table does not jump when the data lands. */
export function Pending({ rows = 5 }: { rows?: number }) {
  return (
    <div className="flex flex-col gap-2 py-2">
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className="h-8 w-full" />
      ))}
    </div>
  );
}

/**
 * The server's own sentence, shown as written.
 *
 * Every rejection from /api names the valid values ("known: v1.2, v1.3"), which
 * is the entire reason it is worth reading. Replacing it with "something went
 * wrong" would throw away the only part that tells the reader what to do next.
 */
export function Failure({ message }: { message: string }) {
  return (
    <Alert variant="destructive" className="my-4">
      <AlertTitle>sift could not answer that</AlertTitle>
      <AlertDescription className="font-mono text-xs">{message}</AlertDescription>
    </Alert>
  );
}
