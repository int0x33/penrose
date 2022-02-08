import { compileDomain } from "@penrose/core";
import { ComponentMeta, ComponentStory } from "@storybook/react";
import Listing from "../Listing";
import { continuousMap, oneSet } from "./PenrosePrograms";

// const diagram = await getDiagram();

// More on default export: https://storybook.js.org/docs/react/writing-stories/introduction#default-export
export default {
  title: "Example/Listing Component",
  component: Listing,
  // More on argTypes: https://storybook.js.org/docs/react/api/argtypes
  // argTypes: {
  //   backgroundColor: { control: 'color' },
  // },
} as ComponentMeta<typeof Listing>;

// More on component templates: https://storybook.js.org/docs/react/writing-stories/introduction#using-args
const Template: ComponentStory<typeof Listing> = (args) => (
  <div style={{ width: "100%", height: "100%" }}>
    <Listing {...args} />
  </div>
);

export const ContinuousMap = Template.bind({});
const setTheoryEnv = compileDomain(continuousMap.domainString).unsafelyUnwrap();

ContinuousMap.args = {
  value: continuousMap.substanceString,
  env: setTheoryEnv,
  width: "400px",
  height: "300px",
};

export const OneSet = Template.bind({});
OneSet.args = {
  value: oneSet.substanceString,
  env: setTheoryEnv,
  width: "400px",
  height: "300px",
};
