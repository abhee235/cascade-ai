import {
  Select, SelectTrigger, SelectValue, SelectContent,
  SelectItem, SelectGroup, SelectLabel, SelectSeparator,
} from '@cascade/web'

export const Open = () => (
  <Select defaultValue="luna" defaultOpen>
    <SelectTrigger className="w-56"><SelectValue placeholder="Select a model" /></SelectTrigger>
    <SelectContent>
      <SelectGroup>
        <SelectLabel>Hosted (OpenAI)</SelectLabel>
        <SelectItem value="luna">gpt-6-luna</SelectItem>
        <SelectItem value="gpt41">gpt-4.1</SelectItem>
        <SelectItem value="gpt4o">gpt-4o-mini</SelectItem>
      </SelectGroup>
      <SelectSeparator />
      <SelectGroup>
        <SelectLabel>Local (Ollama)</SelectLabel>
        <SelectItem value="qwen">qwen2.5-coder</SelectItem>
      </SelectGroup>
    </SelectContent>
  </Select>
)

export const Triggers = () => (
  <div className="flex flex-col gap-3">
    <Select defaultValue="luna">
      <SelectTrigger className="w-56"><SelectValue /></SelectTrigger>
      <SelectContent>
        <SelectItem value="luna">gpt-6-luna</SelectItem>
        <SelectItem value="gpt41">gpt-4.1</SelectItem>
      </SelectContent>
    </Select>
    <Select>
      <SelectTrigger className="w-56"><SelectValue placeholder="Select a model" /></SelectTrigger>
      <SelectContent><SelectItem value="luna">gpt-6-luna</SelectItem></SelectContent>
    </Select>
    <Select disabled>
      <SelectTrigger className="w-56"><SelectValue placeholder="Disabled" /></SelectTrigger>
      <SelectContent><SelectItem value="x">x</SelectItem></SelectContent>
    </Select>
  </div>
)
