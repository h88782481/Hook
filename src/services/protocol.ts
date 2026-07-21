export type ArtExecutionType =
    | 'script'
    | 'python'
    | 'cloud_api'
    | 'shader'
    | 'mcp'
    | 'workflow'
    | 'native'
    | 'filter';

export interface ArtParam {
    id: string;
    label: string;
    widget: string; // "slider" | "checkbox" | "radio" | "select" | "color" | "text" | "file" | "image_link"
    min?: number;
    max?: number;
    default: any; // Can be number, boolean, string, null
    step?: number;
    options?: string[]; // For radio/select widgets
    multiline?: boolean; // For text widget
    group?: string; // Optional UI grouping label for large parameter panels
    data_type?: string;
}

export interface ArtCapability {
    id: string;
    label: string;
    description: string;
    params: ArtParam[];
    auto_process?: boolean;
    execution_type?: ArtExecutionType;
    execution?: Record<string, unknown>;
    defaultVisibility?: Record<string, boolean>;
    inputs?: {
        name: string;
        label: string;
        type: string;
        default?: unknown;
        defaultVisible?: boolean;
        execution_type?: string;
        data_type?: string;
        widget?: string;
    }[];
    outputs?: { name: string; label: string; type: string; defaultVisible?: boolean; }[];
}
