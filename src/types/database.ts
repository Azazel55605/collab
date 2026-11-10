/** Desktop database metadata only. Passwords never enter stores or persistence. */
export interface DatabaseConnection {
  id: string;
  label: string;
  environment: string;
  host: string;
  port: number;
  database: string;
  username: string;
  certificate_hostname: string | null;
  remember_password: boolean;
}
export interface DatabaseConnected {
  id: string;
  saved_id: string;
  label: string;
  environment: string;
  database: string;
}
export interface DatabaseBinding {
  profile_id: string;
  connection_id: string;
  session_id: string;
  tab_id: string;
  database: string;
  generation: number;
}
export interface DatabaseWorkspace {
  token: string;
  profiles: DatabaseConnection[];
  connections: DatabaseConnected[];
  tabs: DatabaseBinding[];
  durable_credentials: boolean;
}
export type DatabaseMetadataRequest =
  | { kind: 'databases'; after: string }
  | { kind: 'schemas'; after: number }
  | { kind: 'objects'; schema_id: number; after: number }
  | { kind: 'columns' | 'indexes'; object_id: number; after: number };
export interface DatabaseMetadataItem {
  id: string;
  name: string;
  kind: string;
  detail: string;
}
export interface DatabaseMetadataPage {
  items: DatabaseMetadataItem[];
  next: string | null;
}
